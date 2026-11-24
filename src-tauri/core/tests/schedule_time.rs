use chrono::DateTime;
use gitverse_core::git::ScheduledGitAction;
use gitverse_core::scheduler::{
    collect_missed_schedules, load_schedules, next_schedule_time, save_schedules, NewSchedule,
    RepositoryResult, RepositoryStatus, RunStatus, RunTrigger, Schedule, ScheduleScope,
    ScheduleTiming, SchedulerLease,
};

fn instant(value: &str) -> i64 {
    DateTime::parse_from_rfc3339(value)
        .unwrap()
        .timestamp_millis()
}

fn bangkok() -> ScheduleTiming {
    ScheduleTiming {
        time_zone: "Asia/Bangkok".into(),
        hour: 9,
        minute: 0,
        weekday: None,
    }
}

#[test]
fn daily_weekly_and_missed_occurrences_match_electron() {
    let daily = bangkok();
    assert_eq!(
        next_schedule_time(&daily, instant("2026-11-24T01:00:00Z")).unwrap(),
        instant("2026-11-24T02:00:00Z")
    );
    assert_eq!(
        next_schedule_time(&daily, instant("2026-11-24T02:00:00Z")).unwrap(),
        instant("2026-11-25T02:00:00Z")
    );
    let weekly = ScheduleTiming {
        weekday: Some(1),
        ..daily.clone()
    };
    assert_eq!(
        next_schedule_time(&weekly, instant("2026-11-24T02:00:00Z")).unwrap(),
        instant("2026-11-30T02:00:00Z")
    );
    let missed = collect_missed_schedules(
        &daily,
        instant("2026-11-22T02:00:00Z"),
        instant("2026-11-24T03:00:00Z"),
    )
    .unwrap();
    assert_eq!(missed.count, 3);
    assert_eq!(missed.latest, Some(instant("2026-11-24T02:00:00Z")));
    assert_eq!(missed.next, instant("2026-11-25T02:00:00Z"));
}

#[test]
fn dst_gaps_are_skipped_and_overlaps_run_once() {
    let timing = ScheduleTiming {
        time_zone: "America/New_York".into(),
        hour: 2,
        minute: 30,
        weekday: None,
    };
    assert_eq!(
        next_schedule_time(&timing, instant("2026-03-08T05:00:00Z")).unwrap(),
        instant("2026-03-09T06:30:00Z")
    );
    let overlap = ScheduleTiming { hour: 1, ..timing };
    assert_eq!(
        next_schedule_time(&overlap, instant("2026-11-01T04:00:00Z")).unwrap(),
        instant("2026-11-01T05:30:00Z")
    );
    assert_eq!(
        next_schedule_time(&overlap, instant("2026-11-01T05:30:00Z")).unwrap(),
        instant("2026-11-02T06:30:00Z")
    );
}

#[test]
fn rejects_invalid_times_and_zones_even_when_nothing_is_due() {
    let invalid = ScheduleTiming {
        time_zone: "Not/A_Zone".into(),
        ..bangkok()
    };
    assert!(collect_missed_schedules(&invalid, 2000, 1000).is_err());
    assert!(next_schedule_time(
        &ScheduleTiming {
            hour: 24,
            ..bangkok()
        },
        0
    )
    .is_err());
    assert!(collect_missed_schedules(&bangkok(), i64::MAX, 0).is_err());
}

fn schedule() -> Schedule {
    Schedule::new(
        NewSchedule {
            id: "morning".into(),
            name: "Morning fetch".into(),
            action: ScheduledGitAction::Fetch,
            timing: bangkok(),
            scope: ScheduleScope::Open,
        },
        instant("2026-11-24T01:00:00Z"),
    )
    .unwrap()
}

#[test]
fn missed_runs_and_results_match_electron_state_transitions() {
    let mut schedule = schedule();
    let now = instant("2026-11-27T03:00:00Z");
    assert!(!schedule.advance(now, false, "unused", 30_000).unwrap());
    assert_eq!(schedule.missed.as_ref().unwrap().count, 4);
    assert_eq!(schedule.next_due, instant("2026-11-28T02:00:00Z"));
    assert!(!schedule.advance(now, false, "unused", 30_000).unwrap());
    assert_eq!(schedule.missed.as_ref().unwrap().count, 4);
    schedule.begin("run-1", now, RunTrigger::Missed).unwrap();
    assert!(schedule.missed.is_none());
    schedule
        .record(
            "run-1",
            RepositoryResult {
                repo: "/one".into(),
                status: RepositoryStatus::Success,
                detail: None,
            },
        )
        .unwrap();
    schedule
        .record(
            "run-1",
            RepositoryResult {
                repo: "/two".into(),
                status: RepositoryStatus::Failed,
                detail: Some("Network error".into()),
            },
        )
        .unwrap();
    schedule.finish("run-1").unwrap();
    assert_eq!(schedule.history[0].status, RunStatus::Partial);
    assert_eq!(schedule.history[0].missed.as_ref().unwrap().count, 4);
    assert!(schedule.finish("run-1").is_err());
}

#[test]
fn on_time_claim_is_atomic_and_recovery_preserves_pending_work() {
    let mut schedule = schedule();
    schedule
        .advance(instant("2026-11-24T03:00:00Z"), false, "unused", 30_000)
        .unwrap();
    assert!(schedule
        .advance(instant("2026-11-25T02:00:10Z"), true, "run-1", 30_000)
        .unwrap());
    assert_eq!(schedule.running.as_ref().unwrap().id, "run-1");
    assert_eq!(schedule.missed.as_ref().unwrap().count, 1);
    schedule.recover();
    assert_eq!(schedule.history[0].status, RunStatus::Interrupted);
    assert_eq!(schedule.missed.as_ref().unwrap().count, 1);
    schedule
        .skip_missed("skip-1", instant("2026-11-25T03:00:00Z"))
        .unwrap();
    assert_eq!(schedule.history[0].status, RunStatus::Skipped);
    assert!(schedule.missed.is_none());
}

#[test]
fn schedule_json_matches_the_electron_shape() {
    let mut schedule = schedule();
    schedule
        .begin("run-1", instant("2026-11-24T01:00:00Z"), RunTrigger::Manual)
        .unwrap();
    let value = serde_json::to_value(&schedule).unwrap();
    assert_eq!(value["action"], "fetch");
    assert_eq!(value["scope"]["kind"], "open");
    assert_eq!(value["timing"]["timeZone"], "Asia/Bangkok");
    assert_eq!(
        value["running"]["startedAt"],
        instant("2026-11-24T01:00:00Z")
    );
    assert_eq!(value["running"]["status"], "running");
    assert_eq!(serde_json::from_value::<Schedule>(value).unwrap(), schedule);
}

#[test]
fn persists_and_recovers_without_overwriting_corrupt_data() {
    let dir = tempfile::tempdir().unwrap();
    assert!(load_schedules(dir.path()).unwrap().is_empty());
    let item = schedule();
    save_schedules(dir.path(), std::slice::from_ref(&item)).unwrap();
    assert_eq!(load_schedules(dir.path()).unwrap(), vec![item.clone()]);
    let file = dir.path().join("schedules.json");
    let before = std::fs::read(&file).unwrap();
    assert!(save_schedules(dir.path(), &[item.clone(), item]).is_err());
    assert_eq!(std::fs::read(&file).unwrap(), before);
    std::fs::write(&file, "{invalid").unwrap();
    assert!(load_schedules(dir.path()).is_err());
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "{invalid");
}

#[test]
fn reads_the_shared_electron_and_tauri_schedule_fixture() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/scheduler");
    let contents = std::fs::read_to_string(dir.join("schedules.json")).unwrap();
    let expected: serde_json::Value = serde_json::from_str(&contents).unwrap();
    let schedules = load_schedules(&dir).unwrap();
    assert_eq!(
        serde_json::to_value(schedules).unwrap(),
        expected["schedules"]
    );
}

#[test]
fn rejects_missing_nullable_fields_null_optional_fields_and_unsafe_counts() {
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/scheduler/schedules.json");
    let original: serde_json::Value =
        serde_json::from_slice(&std::fs::read(fixture).unwrap()).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("schedules.json");
    for field in [
        "weekday",
        "missed",
        "running",
        "detail",
        "runMissed",
        "count",
    ] {
        let mut value = original.clone();
        let item = &mut value["schedules"][0];
        match field {
            "weekday" => {
                item["timing"].as_object_mut().unwrap().remove("weekday");
            }

            "missed" | "running" => {
                item.as_object_mut().unwrap().remove(field);
            }
            "detail" => item["history"][0]["results"][0]["detail"] = serde_json::Value::Null,
            "runMissed" => item["history"][0]["missed"] = serde_json::Value::Null,
            "count" => item["missed"]["count"] = serde_json::json!(9_007_199_254_740_992_u64),
            _ => unreachable!(),
        }
        std::fs::write(&file, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(
            load_schedules(dir.path()).is_err(),
            "accepted invalid {field}"
        );
    }
}

#[test]
fn scheduler_lease_blocks_another_owner_and_allows_clean_restart() {
    let dir = tempfile::tempdir().unwrap();
    let lease = SchedulerLease::acquire(dir.path(), "first".into(), false).unwrap();
    assert!(SchedulerLease::acquire(dir.path(), "second".into(), true).is_err());
    lease.release().unwrap();
    SchedulerLease::acquire(dir.path(), "second".into(), false)
        .unwrap()
        .release()
        .unwrap();
}

#[cfg(unix)]
#[test]
fn stale_scheduler_lease_preserves_interrupted_runs() {
    let dir = tempfile::tempdir().unwrap();
    let lock = dir.path().join("schedules.lock");
    let stale = r#"{"pid":2147483647,"token":"old"}"#;
    std::fs::write(&lock, stale).unwrap();
    SchedulerLease::acquire(dir.path(), "new".into(), false)
        .unwrap()
        .release()
        .unwrap();
    let mut item = schedule();
    item.begin("run", instant("2026-11-24T01:00:00Z"), RunTrigger::Manual)
        .unwrap();
    save_schedules(dir.path(), &[item]).unwrap();
    std::fs::write(&lock, stale).unwrap();
    assert!(SchedulerLease::acquire(dir.path(), "new".into(), false).is_err());
    assert_eq!(std::fs::read_to_string(&lock).unwrap(), stale);
    SchedulerLease::acquire(dir.path(), "new".into(), true)
        .unwrap()
        .release()
        .unwrap();
}
