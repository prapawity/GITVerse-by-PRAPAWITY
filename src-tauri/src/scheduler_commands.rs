use std::collections::HashSet;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use gitverse_core::git::{queued_scheduled_git, ScheduledGitResult};
use gitverse_core::scheduler::{
    load_schedules, save_schedules, NewSchedule, RepositoryResult, RepositoryStatus, RunTrigger,
    Schedule, ScheduleScope, SchedulerLease,
};
use gitverse_core::AppError;
use serde::Serialize;
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

use crate::AppState;

type Result<T> = std::result::Result<T, AppError>;
type PendingRun = (String, String, Option<Vec<String>>);

#[derive(Default)]
pub struct SchedulerRuntime {
    inner: Mutex<Inner>,
    execution: Mutex<()>,
}

#[derive(Default)]
struct Inner {
    schedules: Vec<Schedule>,
    repos: Vec<String>,
    loaded: bool,
    started: bool,
    stopped: bool,
    error: Option<String>,
    unsafe_cleanup: bool,
    lease: Option<SchedulerLease>,
}

#[derive(Serialize)]
pub struct SchedulerSnapshot {
    schedules: Vec<Schedule>,
    error: Option<String>,
}

fn now() -> Result<i64> {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| AppError::Invalid("The system clock is before 1970.".into()))?
        .as_millis();
    i64::try_from(ms).map_err(|_| AppError::Invalid("The system clock is invalid.".into()))
}

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn changed(handle: &tauri::AppHandle) {
    if let Err(error) = handle.emit("scheduler:changed", ()) {
        eprintln!("[scheduler] Could not notify the window: {error}");
    }
}

fn repos_valid(repos: Vec<String>) -> Result<Vec<String>> {
    if repos.iter().any(String::is_empty) {
        return Err(AppError::Invalid("Invalid open repository list.".into()));
    }
    let mut seen = HashSet::new();
    Ok(repos
        .into_iter()
        .filter(|repo| seen.insert(repo.clone()))
        .collect())
}

fn save(app: &AppState, inner: &mut Inner, schedules: Vec<Schedule>) -> Result<()> {
    if let Err(error) = save_schedules(&app.data_dir, &schedules) {
        inner.error = Some(error.to_string());
        return Err(error);
    }
    inner.schedules = schedules;
    Ok(())
}

fn snapshot(inner: &Inner) -> Result<SchedulerSnapshot> {
    if !inner.loaded {
        return Err(AppError::Invalid(
            inner
                .error
                .clone()
                .unwrap_or_else(|| "The scheduler is not ready.".into()),
        ));
    }
    Ok(SchedulerSnapshot {
        schedules: inner.schedules.clone(),
        error: inner.error.clone(),
    })
}

fn require_ready(inner: &Inner) -> Result<()> {
    if inner.stopped {
        return Err(AppError::Invalid("The scheduler is stopping.".into()));
    }
    if !inner.loaded {
        return Err(AppError::Invalid("The scheduler is not ready.".into()));
    }
    if let Some(error) = &inner.error {
        return Err(AppError::Invalid(format!(
            "The scheduler is paused: {error}"
        )));
    }
    Ok(())
}

fn advance(schedules: &mut [Schedule], current: i64, on_time: bool) -> Result<Vec<PendingRun>> {
    let mut runs = Vec::new();
    for schedule in schedules {
        let run_id = id();
        if schedule.advance(current, on_time, &run_id, 30_000)? {
            runs.push((schedule.id.clone(), run_id, None));
        }
    }
    Ok(runs)
}

async fn initialize(
    app: &AppState,
    handle: &tauri::AppHandle,
    reload: bool,
    recover_interrupted: bool,
) -> Result<bool> {
    let mut inner = app.scheduler.inner.lock().await;
    if inner.unsafe_cleanup {
        return Err(AppError::ScheduledCleanup);
    }
    if inner.lease.is_none() {
        inner.lease = Some(SchedulerLease::acquire(
            &app.data_dir,
            id(),
            recover_interrupted,
        )?);
    }
    if !inner.loaded || reload {
        let mut schedules = load_schedules(&app.data_dir)?;
        let interrupted = schedules.iter().any(|schedule| schedule.running.is_some());
        for schedule in &mut schedules {
            schedule.recover();
        }

        advance(&mut schedules, now()?, false)?;
        if interrupted || !schedules.is_empty() {
            save_schedules(&app.data_dir, &schedules)?;
        }
        inner.schedules = schedules;
        inner.loaded = true;
        inner.error = None;
    }
    let start = !inner.started;
    inner.started = true;
    drop(inner);
    changed(handle);
    Ok(start)
}

pub fn release_on_exit(app: &AppState) {
    let Ok(_execution) = app.scheduler.execution.try_lock() else {
        return;
    };
    match app.scheduler.inner.try_lock() {
        Ok(mut inner)
            if inner
                .schedules
                .iter()
                .all(|schedule| schedule.running.is_none()) =>
        {
            inner.stopped = true;
            if let Some(lease) = &inner.lease {
                if let Err(error) = lease.release() {
                    eprintln!("[scheduler] Could not release the scheduler lock: {error}");
                }
            }
        }
        Ok(_) | Err(_) => {}
    }
}

fn start_clock(handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last_tick = match now() {
            Ok(value) => Some(value),
            Err(error) => {
                pause(&handle, error).await;
                None
            }
        };
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            if handle
                .state::<AppState>()
                .scheduler
                .inner
                .lock()
                .await
                .stopped
            {
                break;
            }
            let current = match now() {
                Ok(value) => value,
                Err(error) => {
                    pause(&handle, error).await;
                    continue;
                }
            };
            let on_time = last_tick.is_some_and(|last| current >= last && current - last <= 5_000);
            last_tick = Some(current);
            if let Err(error) = poll(&handle, current, on_time).await {
                pause(&handle, error).await;
            }
        }
    });
}

async fn pause(handle: &tauri::AppHandle, error: AppError) {
    eprintln!("[scheduler] {error}");
    let app = handle.state::<AppState>();
    let mut inner = app.scheduler.inner.lock().await;
    inner.error = Some(error.to_string());
    drop(inner);
    changed(handle);
}

async fn poll(handle: &tauri::AppHandle, current: i64, on_time: bool) -> Result<()> {
    let app = handle.state::<AppState>();
    let _execution = app.scheduler.execution.lock().await;
    let runs = {
        let mut inner = app.scheduler.inner.lock().await;
        if inner.error.is_some() || !inner.loaded || inner.stopped {
            return Ok(());
        }
        let actual = now()?;
        let on_time = on_time && actual >= current && actual - current <= 5_000;
        let mut schedules = inner.schedules.clone();
        let runs = advance(&mut schedules, actual, on_time)?;
        if schedules != inner.schedules {
            save(&app, &mut inner, schedules)?;
            changed(handle);
        }
        runs
    };
    execute_batch(&app, handle, runs).await
}

async fn execute_batch(
    app: &AppState,
    handle: &tauri::AppHandle,
    runs: Vec<PendingRun>,
) -> Result<()> {
    for (schedule_id, run_id, override_repos) in runs {
        let (action, repositories) = {
            let inner = app.scheduler.inner.lock().await;
            let schedule = inner
                .schedules
                .iter()
                .find(|item| item.id == schedule_id)
                .ok_or_else(|| AppError::Invalid("Schedule not found.".into()))?;
            let repos = override_repos.unwrap_or_else(|| match &schedule.scope {
                ScheduleScope::Open => inner.repos.clone(),
                ScheduleScope::Selected { repos } => repos.clone(),
            });
            (schedule.action, repos_valid(repos)?)
        };
        for repo in repositories {
            let outcome = queued_scheduled_git(
                &app.repository_queue,
                &app.git,
                Path::new(&repo),
                action,
                false,
                Duration::from_secs(30),
            )
            .await;
            if matches!(outcome, Err(AppError::ScheduledCleanup)) {
                app.scheduler.inner.lock().await.unsafe_cleanup = true;
                return Err(AppError::ScheduledCleanup);
            }
            let result = match outcome {
                Ok(ScheduledGitResult::Success) => RepositoryResult {
                    repo,
                    status: RepositoryStatus::Success,
                    detail: None,
                },
                Ok(ScheduledGitResult::Skipped { reason }) => RepositoryResult {
                    repo,
                    status: RepositoryStatus::Skipped,
                    detail: Some(reason),
                },
                Err(error) => {
                    let message = error.to_string();
                    let name = format!("{action:?}").to_lowercase();
                    let safe = [
                        format!("Scheduled {name} failed. Check the repository, network, and credentials."),
                        format!("Scheduled {name} timed out. Check the network and credentials."),
                    ];
                    let detail = if safe.contains(&message) {
                        message
                    } else {
                        "Git operation failed. Check the repository and credentials.".into()
                    };
                    RepositoryResult {
                        repo,
                        status: RepositoryStatus::Failed,
                        detail: Some(detail),
                    }
                }
            };
            let mut inner = app.scheduler.inner.lock().await;
            let mut schedules = inner.schedules.clone();
            find(&mut schedules, &schedule_id)?.record(&run_id, result)?;
            save(app, &mut inner, schedules)?;
            drop(inner);
            changed(handle);
        }
        let mut inner = app.scheduler.inner.lock().await;
        let mut schedules = inner.schedules.clone();
        find(&mut schedules, &schedule_id)?.finish(&run_id)?;
        save(app, &mut inner, schedules)?;
        drop(inner);
        changed(handle);
    }
    Ok(())
}

fn find<'a>(schedules: &'a mut [Schedule], id: &str) -> Result<&'a mut Schedule> {
    schedules
        .iter_mut()
        .find(|schedule| schedule.id == id)
        .ok_or_else(|| AppError::Invalid("Schedule not found.".into()))
}

#[tauri::command]
pub async fn scheduler_init(
    app: tauri::State<'_, AppState>,
    handle: tauri::AppHandle,
    repos: Vec<String>,
) -> Result<SchedulerSnapshot> {
    let _execution = app.scheduler.execution.lock().await;
    app.scheduler.inner.lock().await.repos = repos_valid(repos)?;
    if initialize(&app, &handle, false, false).await? {
        start_clock(handle);
    }
    snapshot(&*app.scheduler.inner.lock().await)
}

#[tauri::command]
pub async fn scheduler_repos(app: tauri::State<'_, AppState>, repos: Vec<String>) -> Result<()> {
    app.scheduler.inner.lock().await.repos = repos_valid(repos)?;
    Ok(())
}

#[tauri::command]
pub async fn scheduler_list(app: tauri::State<'_, AppState>) -> Result<SchedulerSnapshot> {
    snapshot(&*app.scheduler.inner.lock().await)
}

#[tauri::command]
pub async fn scheduler_retry(
    app: tauri::State<'_, AppState>,
    handle: tauri::AppHandle,
) -> Result<SchedulerSnapshot> {
    let _execution = app.scheduler.execution.lock().await;
    if initialize(&app, &handle, true, false).await? {
        start_clock(handle);
    }
    snapshot(&*app.scheduler.inner.lock().await)
}

#[tauri::command]
pub async fn scheduler_recover(
    app: tauri::State<'_, AppState>,
    handle: tauri::AppHandle,
) -> Result<SchedulerSnapshot> {
    let _execution = app.scheduler.execution.lock().await;
    if initialize(&app, &handle, true, true).await? {
        start_clock(handle);
    }
    snapshot(&*app.scheduler.inner.lock().await)
}

#[tauri::command]
pub async fn scheduler_add(
    app: tauri::State<'_, AppState>,
    handle: tauri::AppHandle,
    input: NewSchedule,
) -> Result<Schedule> {
    let mut inner = app.scheduler.inner.lock().await;
    require_ready(&inner)?;
    if inner.schedules.iter().any(|item| item.id == input.id) {
        return Err(AppError::Invalid("Schedule ID already exists.".into()));
    }
    let schedule = Schedule::new(input, now()?)?;
    let mut schedules = inner.schedules.clone();
    schedules.push(schedule.clone());
    save(&app, &mut inner, schedules)?;
    drop(inner);
    changed(&handle);
    Ok(schedule)
}

#[tauri::command]
pub async fn scheduler_update(
    app: tauri::State<'_, AppState>,
    handle: tauri::AppHandle,
    input: NewSchedule,
) -> Result<()> {
    let mut inner = app.scheduler.inner.lock().await;
    require_ready(&inner)?;
    let mut schedules = inner.schedules.clone();
    let old = find(&mut schedules, &input.id)?;
    if old.running.is_some() {
        return Err(AppError::Invalid("Cannot edit a running schedule.".into()));
    }
    if old.missed.is_some() {
        return Err(AppError::Invalid(
            "Run or skip missed occurrences before editing this schedule.".into(),
        ));
    }
    let mut new = Schedule::new(input, now()?)?;
    new.enabled = old.enabled;
    new.history = old.history.clone();
    *old = new;
    save(&app, &mut inner, schedules)?;
    drop(inner);
    changed(&handle);
    Ok(())
}

#[tauri::command]
pub async fn scheduler_enable(
    app: tauri::State<'_, AppState>,
    handle: tauri::AppHandle,
    id: String,
    enabled: bool,
) -> Result<()> {
    let mut inner = app.scheduler.inner.lock().await;
    require_ready(&inner)?;
    let mut schedules = inner.schedules.clone();
    let item = find(&mut schedules, &id)?;
    if item.running.is_some() {
        return Err(AppError::Invalid(
            "Cannot change a running schedule.".into(),
        ));
    }
    if item.enabled != enabled {
        if enabled {
            item.next_due = gitverse_core::scheduler::next_schedule_time(&item.timing, now()?)?;
        }
        item.enabled = enabled;
    }
    save(&app, &mut inner, schedules)?;
    drop(inner);
    changed(&handle);
    Ok(())
}

#[tauri::command]
pub async fn scheduler_remove(
    app: tauri::State<'_, AppState>,
    handle: tauri::AppHandle,
    id: String,
) -> Result<()> {
    let mut inner = app.scheduler.inner.lock().await;
    require_ready(&inner)?;
    let mut schedules = inner.schedules.clone();
    if find(&mut schedules, &id)?.running.is_some() {
        return Err(AppError::Invalid(
            "Cannot delete a running schedule.".into(),
        ));
    }
    schedules.retain(|item| item.id != id);
    save(&app, &mut inner, schedules)?;
    drop(inner);
    changed(&handle);
    Ok(())
}

#[tauri::command]
pub async fn scheduler_run(
    app: tauri::State<'_, AppState>,
    handle: tauri::AppHandle,
    id: String,
) -> Result<()> {
    let _execution = app.scheduler.execution.lock().await;
    let run_id = uuid::Uuid::new_v4().to_string();
    {
        let mut inner = app.scheduler.inner.lock().await;
        require_ready(&inner)?;
        let mut schedules = inner.schedules.clone();
        find(&mut schedules, &id)?.begin(&run_id, now()?, RunTrigger::Manual)?;
        save(&app, &mut inner, schedules)?;
    }
    changed(&handle);
    if let Err(error) = execute_batch(&app, &handle, vec![(id, run_id, None)]).await {
        pause(&handle, AppError::Invalid(error.to_string())).await;
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub async fn scheduler_retry_failed(
    app: tauri::State<'_, AppState>,
    handle: tauri::AppHandle,
    id: String,
    previous_run_id: String,
) -> Result<()> {
    let _execution = app.scheduler.execution.lock().await;
    let run_id = uuid::Uuid::new_v4().to_string();
    let repos = {
        let mut inner = app.scheduler.inner.lock().await;
        require_ready(&inner)?;
        let mut schedules = inner.schedules.clone();
        let item = find(&mut schedules, &id)?;
        let previous = item
            .history
            .iter()
            .find(|run| run.id == previous_run_id)
            .ok_or_else(|| AppError::Invalid("The previous schedule run was not found.".into()))?;
        let repos: Vec<_> = previous
            .results
            .iter()
            .filter(|result| result.status == RepositoryStatus::Failed)
            .map(|result| result.repo.clone())
            .collect();
        if repos.is_empty() {
            return Err(AppError::Invalid(
                "The previous run has no failed repositories.".into(),
            ));
        }
        item.begin(&run_id, now()?, RunTrigger::Manual)?;
        save(&app, &mut inner, schedules)?;
        repos
    };
    changed(&handle);
    if let Err(error) = execute_batch(&app, &handle, vec![(id, run_id, Some(repos))]).await {
        pause(&handle, AppError::Invalid(error.to_string())).await;
        return Err(error);
    }
    Ok(())
}

fn selection(schedules: &mut [Schedule], ids: &[String]) -> Result<()> {
    let distinct: HashSet<_> = ids.iter().collect();
    if ids.is_empty() || distinct.len() != ids.len() {
        return Err(AppError::Invalid(
            "Select one or more distinct schedules.".into(),
        ));
    }
    for id in ids {
        let item = find(schedules, id)?;
        if item.missed.is_none() || item.running.is_some() {
            return Err(AppError::Invalid(
                "A selected schedule no longer has a missed run.".into(),
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn scheduler_run_missed(
    app: tauri::State<'_, AppState>,
    handle: tauri::AppHandle,
    ids: Vec<String>,
) -> Result<()> {
    let _execution = app.scheduler.execution.lock().await;
    let runs = {
        let mut inner = app.scheduler.inner.lock().await;
        require_ready(&inner)?;
        let mut schedules = inner.schedules.clone();
        selection(&mut schedules, &ids)?;
        let current = now()?;
        let mut runs = Vec::new();
        for schedule_id in ids {
            let run_id = id();
            find(&mut schedules, &schedule_id)?.begin(&run_id, current, RunTrigger::Missed)?;
            runs.push((schedule_id, run_id, None));
        }
        save(&app, &mut inner, schedules)?;
        runs
    };
    changed(&handle);
    if let Err(error) = execute_batch(&app, &handle, runs).await {
        pause(&handle, AppError::Invalid(error.to_string())).await;
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub async fn scheduler_skip_missed(
    app: tauri::State<'_, AppState>,
    handle: tauri::AppHandle,
    ids: Vec<String>,
) -> Result<()> {
    let mut inner = app.scheduler.inner.lock().await;
    require_ready(&inner)?;
    let mut schedules = inner.schedules.clone();
    selection(&mut schedules, &ids)?;
    let current = now()?;
    for schedule_id in ids {
        find(&mut schedules, &schedule_id)?.skip_missed(&id(), current)?;
    }
    save(&app, &mut inner, schedules)?;
    drop(inner);
    changed(&handle);
    Ok(())
}
