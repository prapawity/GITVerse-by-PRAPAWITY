use std::str::FromStr;
use std::{io::Write, path::Path};

use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Deserializer, Serialize};

use crate::error::{AppError, Result};
use crate::git::ScheduledGitAction;

mod lease;
pub use lease::SchedulerLease;

fn required_nullable<'de, D, T>(deserializer: D) -> std::result::Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::deserialize(deserializer)
}

fn optional_non_null<'de, D, T>(deserializer: D) -> std::result::Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleTiming {
    pub time_zone: String,
    pub hour: u32,
    pub minute: u32,
    /// None means every day; 0 is Sunday.
    #[serde(deserialize_with = "required_nullable")]
    pub weekday: Option<u32>,
}

fn invalid(message: &str) -> AppError {
    AppError::Invalid(message.into())
}

/// Returns the first occurrence strictly after `after_ms`.
/// Missing local times are skipped, and repeated local times use their earlier instant.
pub fn next_schedule_time(timing: &ScheduleTiming, after_ms: i64) -> Result<i64> {
    if timing.hour > 23 || timing.minute > 59 || timing.weekday.is_some_and(|day| day > 6) {
        return Err(invalid("Invalid schedule timing."));
    }
    let zone =
        Tz::from_str(&timing.time_zone).map_err(|_| invalid("Invalid schedule time zone."))?;
    let after = DateTime::<Utc>::from_timestamp_millis(after_ms)
        .ok_or_else(|| invalid("Invalid schedule time."))?;
    let first = after.with_timezone(&zone).date_naive();
    for offset in 0..=15 {
        let day: NaiveDate = first
            .checked_add_signed(Duration::days(offset))
            .ok_or_else(|| invalid("Invalid schedule time."))?;
        if timing
            .weekday
            .is_some_and(|weekday| day.weekday().num_days_from_sunday() != weekday)
        {
            continue;
        }
        let local = day
            .and_hms_opt(timing.hour, timing.minute, 0)
            .ok_or_else(|| invalid("Invalid schedule timing."))?;
        let occurrence = match zone.from_local_datetime(&local) {
            LocalResult::Single(value) => value,
            LocalResult::Ambiguous(a, b) => a.min(b),
            LocalResult::None => continue,
        };
        let occurrence_ms = occurrence.timestamp_millis();
        if occurrence_ms > after_ms {
            return Ok(occurrence_ms);
        }
    }
    Err(invalid("Could not calculate the next schedule time."))
}

#[derive(Debug, PartialEq, Eq)]
pub struct MissedOccurrences {
    pub count: u64,
    pub latest: Option<i64>,
    pub next: i64,
}

pub fn collect_missed_schedules(
    timing: &ScheduleTiming,
    next_due: i64,
    now: i64,
) -> Result<MissedOccurrences> {
    // Validate even if no occurrence is due.
    let _ = next_schedule_time(timing, now)?;
    DateTime::<Utc>::from_timestamp_millis(next_due)
        .ok_or_else(|| invalid("Invalid next schedule time."))?;
    let mut next = next_due;
    let mut count = 0u64;
    let mut latest = None;
    while next <= now {
        count = count
            .checked_add(1)
            .ok_or_else(|| invalid("Too many missed schedule occurrences."))?;
        latest = Some(next);
        next = next_schedule_time(timing, next)?;
    }
    Ok(MissedOccurrences {
        count,
        latest,
        next,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum ScheduleScope {
    Open,
    Selected { repos: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MissedSchedule {
    pub count: u64,
    pub latest: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RepositoryStatus {
    Success,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RepositoryResult {
    pub repo: String,
    pub status: RepositoryStatus,
    #[serde(
        default,
        deserialize_with = "optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunTrigger {
    Scheduled,
    Missed,
    Manual,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Running,
    Success,
    Partial,
    Failed,
    Skipped,
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduledRun {
    pub id: String,
    pub started_at: i64,
    pub trigger: RunTrigger,
    pub status: RunStatus,
    pub results: Vec<RepositoryResult>,
    #[serde(
        default,
        deserialize_with = "optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub missed: Option<MissedSchedule>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Schedule {
    pub id: String,
    pub name: String,
    pub action: ScheduledGitAction,
    pub timing: ScheduleTiming,
    pub scope: ScheduleScope,
    pub enabled: bool,
    pub next_due: i64,
    #[serde(deserialize_with = "required_nullable")]
    pub missed: Option<MissedSchedule>,
    #[serde(deserialize_with = "required_nullable")]
    pub running: Option<ScheduledRun>,
    pub history: Vec<ScheduledRun>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewSchedule {
    pub id: String,
    pub name: String,
    pub action: ScheduledGitAction,
    pub timing: ScheduleTiming,
    pub scope: ScheduleScope,
}

impl Schedule {
    pub fn new(mut input: NewSchedule, now: i64) -> Result<Self> {
        if input.id.trim().is_empty() || input.name.trim().is_empty() {
            return Err(invalid("A schedule requires an ID and name."));
        }

        if let ScheduleScope::Selected { repos } = &mut input.scope {
            if repos.is_empty() || repos.iter().any(|repo| repo.trim().is_empty()) {
                return Err(invalid("Select at least one repository."));
            }
            let mut seen = std::collections::HashSet::new();
            repos.retain(|repo| seen.insert(repo.clone()));
        }
        let next_due = next_schedule_time(&input.timing, now)?;
        Ok(Self {
            id: input.id,
            name: input.name.trim().into(),
            action: input.action,
            timing: input.timing,
            scope: input.scope,
            enabled: true,
            next_due,
            missed: None,
            running: None,
            history: vec![],
        })
    }

    pub fn advance(
        &mut self,
        now: i64,
        can_run_on_time: bool,
        run_id: &str,
        grace_ms: i64,
    ) -> Result<bool> {
        if !self.enabled {
            return Ok(false);
        }
        if grace_ms < 0 {
            return Err(invalid("Invalid scheduling grace period."));
        }
        let due = collect_missed_schedules(&self.timing, self.next_due, now)?;
        let Some(latest) = due.latest else {
            return Ok(false);
        };
        let should_run = can_run_on_time
            && self.running.is_none()
            && due.count == 1
            && now.saturating_sub(latest) <= grace_ms;
        if should_run && run_id.trim().is_empty() {
            return Err(invalid("Invalid schedule run."));
        }
        let pending = if should_run {
            self.missed.clone()
        } else {
            Some(MissedSchedule {
                count: self
                    .missed
                    .as_ref()
                    .map_or(0, |missed| missed.count)
                    .checked_add(due.count)
                    .ok_or_else(|| invalid("Too many missed schedule occurrences."))?,
                latest,
            })
        };
        self.next_due = due.next;
        self.missed = pending;
        if should_run {
            self.begin(run_id, now, RunTrigger::Scheduled)?;
        }
        Ok(should_run)
    }

    pub fn begin(&mut self, run_id: &str, now: i64, trigger: RunTrigger) -> Result<()> {
        if self.running.is_some() {
            return Err(invalid("This schedule is already running."));
        }
        if run_id.trim().is_empty() || DateTime::<Utc>::from_timestamp_millis(now).is_none() {
            return Err(invalid("Invalid schedule run."));
        }
        if trigger == RunTrigger::Missed && self.missed.is_none() {
            return Err(invalid("There is no missed schedule to run."));
        }
        let missed = if trigger == RunTrigger::Missed {
            self.missed.take()
        } else {
            None
        };
        self.running = Some(ScheduledRun {
            id: run_id.into(),
            started_at: now,
            trigger,
            status: RunStatus::Running,
            results: vec![],
            missed,
        });
        Ok(())
    }

    pub fn record(&mut self, run_id: &str, result: RepositoryResult) -> Result<()> {
        let run = self
            .running
            .as_mut()
            .filter(|run| run.id == run_id)
            .ok_or_else(|| invalid("The schedule run is no longer active."))?;
        if run.results.iter().any(|item| item.repo == result.repo) {
            return Err(invalid(
                "A result for this repository was already recorded.",
            ));
        }
        run.results.push(result);
        Ok(())
    }

    pub fn finish(&mut self, run_id: &str) -> Result<()> {
        let run = self
            .running
            .as_ref()
            .filter(|run| run.id == run_id)
            .ok_or_else(|| invalid("The schedule run is no longer active."))?;
        let successes = run
            .results
            .iter()
            .filter(|result| result.status == RepositoryStatus::Success)
            .count();
        let failures = run
            .results
            .iter()
            .any(|result| result.status == RepositoryStatus::Failed);
        let status = if successes > 0 && successes == run.results.len() {
            RunStatus::Success
        } else if successes > 0 {
            RunStatus::Partial
        } else if failures {
            RunStatus::Failed
        } else {
            RunStatus::Skipped
        };
        let mut completed = run.clone();
        completed.status = status;
        self.running = None;
        self.history.insert(0, completed);
        self.history.truncate(20);
        Ok(())
    }

    pub fn recover(&mut self) {
        if let Some(mut run) = self.running.take() {
            run.status = RunStatus::Interrupted;
            self.history.insert(0, run);
            self.history.truncate(20);
        }
    }

    pub fn skip_missed(&mut self, run_id: &str, now: i64) -> Result<()> {
        self.begin(run_id, now, RunTrigger::Missed)?;
        self.finish(run_id)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScheduleFile {
    version: u8,
    schedules: Vec<Schedule>,
}

fn validate_schedules(schedules: &[Schedule]) -> Result<()> {
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    let mut ids = std::collections::HashSet::new();
    for schedule in schedules {
        if schedule.id.is_empty()
            || schedule.name.is_empty()
            || !ids.insert(&schedule.id)
            || schedule.history.len() > 20
            || schedule
                .missed
                .as_ref()
                .is_some_and(|item| item.count == 0 || item.count > MAX_SAFE_INTEGER)
        {
            return Err(invalid("Invalid saved schedule."));
        }
        if schedule
            .missed
            .as_ref()
            .is_some_and(|item| DateTime::<Utc>::from_timestamp_millis(item.latest).is_none())
        {
            return Err(invalid("Invalid saved schedule time."));
        }
        if let ScheduleScope::Selected { repos } = &schedule.scope {
            if repos.is_empty() || repos.iter().any(String::is_empty) {
                return Err(invalid("Invalid saved schedule repositories."));
            }
        }
        next_schedule_time(&schedule.timing, schedule.next_due)?;
        if schedule
            .running
            .as_ref()
            .is_some_and(|run| run.status != RunStatus::Running)
            || schedule
                .history
                .iter()
                .any(|run| run.status == RunStatus::Running)
        {
            return Err(invalid("Invalid saved schedule run status."));
        }
        for run in schedule.running.iter().chain(&schedule.history) {
            if run.id.is_empty()
                || run.results.iter().any(|result| result.repo.is_empty())
                || run
                    .missed
                    .as_ref()
                    .is_some_and(|item| item.count == 0 || item.count > MAX_SAFE_INTEGER)
                || DateTime::<Utc>::from_timestamp_millis(run.started_at).is_none()
                || run.missed.as_ref().is_some_and(|item| {
                    DateTime::<Utc>::from_timestamp_millis(item.latest).is_none()
                })
            {
                return Err(invalid("Invalid saved schedule run."));
            }
        }
    }
    Ok(())
}

/// Read the same versioned schedule file as Electron, without replacing corrupt data.
pub fn load_schedules(dir: &Path) -> Result<Vec<Schedule>> {
    let bytes = match std::fs::read(dir.join("schedules.json")) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(error.into()),
    };
    let file: ScheduleFile = serde_json::from_slice(&bytes)
        .map_err(|_| invalid("Saved schedules are invalid. They have not been overwritten."))?;
    if file.version != 1 || validate_schedules(&file.schedules).is_err() {
        return Err(invalid(
            "Saved schedules are invalid. They have not been overwritten.",
        ));
    }
    Ok(file.schedules)
}

/// Validate before atomically replacing persisted state.
pub fn save_schedules(dir: &Path, schedules: &[Schedule]) -> Result<()> {
    validate_schedules(schedules).map_err(|_| invalid("Cannot save invalid schedules."))?;
    std::fs::create_dir_all(dir)?;
    let file = ScheduleFile {
        version: 1,
        schedules: schedules.to_vec(),
    };
    let bytes = serde_json::to_vec(&file)?;
    let mut temp = tempfile::NamedTempFile::new_in(dir)?;
    temp.write_all(&bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(dir.join("schedules.json"))
        .map_err(|error| error.error)?;
    Ok(())
}
