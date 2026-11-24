use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::load_schedules;
use crate::error::{AppError, Result};

const LOCK_MESSAGE: &str = "Another GITVerse scheduler may be running, or its previous run was interrupted. Close other instances and ensure their Git processes have stopped before resolving the scheduler lock.";

#[derive(Serialize, Deserialize)]
struct Owner {
    pid: u32,
    token: String,
}

struct Guard(PathBuf);

impl Guard {
    fn acquire(dir: &Path) -> Result<Self> {
        let path = dir.join("schedules.lock.guard");
        std::fs::create_dir(&path).map_err(|_| AppError::Invalid(LOCK_MESSAGE.into()))?;
        Ok(Self(path))
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir(&self.0) {
            eprintln!("[scheduler] Could not remove lock guard: {error}");
        }
    }
}

pub struct SchedulerLease {
    dir: PathBuf,
    token: String,
}

impl SchedulerLease {
    pub fn acquire(dir: &Path, token: String, recover_interrupted: bool) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        let _guard = Guard::acquire(dir)?;
        let lock = dir.join("schedules.lock");
        match std::fs::read(&lock) {
            Ok(contents) => {
                let owner: Owner = serde_json::from_slice(&contents)
                    .map_err(|_| AppError::Invalid(LOCK_MESSAGE.into()))?;
                if owner.pid == 0 || owner.token.is_empty() || process_alive(owner.pid)? {
                    return Err(AppError::Invalid(LOCK_MESSAGE.into()));
                }
                let schedules = load_schedules(dir)?;
                if !recover_interrupted && schedules.iter().any(|item| item.running.is_some()) {
                    return Err(AppError::Invalid(LOCK_MESSAGE.into()));
                }
                std::fs::remove_file(&lock)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock)?;
        let owner = Owner {
            pid: std::process::id(),
            token: token.clone(),
        };
        serde_json::to_writer(&mut file, &owner)?;
        file.flush()?;
        file.sync_all()?;
        Ok(Self {
            dir: dir.to_owned(),
            token,
        })
    }

    pub fn release(&self) -> Result<()> {
        let _guard = Guard::acquire(&self.dir)?;
        let path = self.dir.join("schedules.lock");
        let owner: Owner = serde_json::from_slice(&std::fs::read(&path)?)?;
        if owner.token != self.token {
            return Err(AppError::Invalid(
                "Scheduler lock ownership changed.".into(),
            ));
        }
        std::fs::remove_file(path)?;
        Ok(())
    }
}

#[cfg(unix)]
fn process_alive(pid: u32) -> Result<bool> {
    if pid > i32::MAX as u32 {
        return Err(AppError::Invalid(LOCK_MESSAGE.into()));
    }
    if unsafe { libc::kill(pid as i32, 0) } == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(false)
    } else {
        Err(AppError::Invalid(LOCK_MESSAGE.into()))
    }
}

#[cfg(windows)]
fn process_alive(pid: u32) -> Result<bool> {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER {
            Ok(false)
        } else {
            Err(AppError::Invalid(LOCK_MESSAGE.into()))
        };
    }
    let mut code = 0;
    let success = unsafe { GetExitCodeProcess(process, &mut code) };
    unsafe { CloseHandle(process) };
    if success == 0 {
        return Err(AppError::Invalid(LOCK_MESSAGE.into()));
    }
    Ok(code == 259)
}
