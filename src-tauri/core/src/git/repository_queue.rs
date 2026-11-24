use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

use super::{GitRunner, RunOpts};
use crate::error::{AppError, Result};

/// Coordinates callers within one app process; external Git processes are not covered.
#[derive(Default)]
pub struct RepositoryQueue {
    locks: Mutex<HashMap<PathBuf, Weak<AsyncMutex<()>>>>,
    poisoned: Mutex<HashSet<PathBuf>>,
}

#[derive(Debug)]
pub struct RepositoryGuard {
    key: PathBuf,
    _guard: OwnedMutexGuard<()>,
}

impl RepositoryQueue {
    pub fn poison(&self, guard: &RepositoryGuard) -> Result<()> {
        self.poisoned
            .lock()
            .map_err(|_| AppError::Invalid("Repository queue is unavailable.".into()))?
            .insert(guard.key.clone());
        Ok(())
    }

    fn check(&self, key: &Path) -> Result<()> {
        if self
            .poisoned
            .lock()
            .map_err(|_| AppError::Invalid("Repository queue is unavailable.".into()))?
            .contains(key)
        {
            return Err(AppError::ScheduledCleanup);
        }
        Ok(())
    }

    pub async fn acquire(
        &self,
        git: &GitRunner,
        repo: &Path,
        timeout: Option<Duration>,
    ) -> Result<RepositoryGuard> {
        let output = git
            .run(
                repo,
                &["rev-parse", "--git-common-dir"],
                RunOpts {
                    timeout: Some(Duration::from_secs(10)),
                    ..RunOpts::default()
                },
            )
            .await?;
        let git_dir = output.strip_suffix('\n').unwrap_or(&output);
        let git_dir = git_dir.strip_suffix('\r').unwrap_or(git_dir);
        if git_dir.is_empty() {
            return Err(AppError::Invalid(
                "Could not determine the repository Git directory.".into(),
            ));
        }
        let key = std::fs::canonicalize(repo.join(git_dir))?;
        self.check(&key)?;
        let lock = {
            let mut locks = self
                .locks
                .lock()
                .map_err(|_| AppError::Invalid("Repository queue is unavailable.".into()))?;
            locks.retain(|_, lock| lock.strong_count() > 0);
            match locks.get(&key).and_then(Weak::upgrade) {
                Some(lock) => lock,
                None => {
                    let lock = Arc::new(AsyncMutex::new(()));
                    locks.insert(key.clone(), Arc::downgrade(&lock));
                    lock
                }
            }
        };
        let guard = match timeout {
            Some(wait) => tokio::time::timeout(wait, lock.lock_owned())
                .await
                .map_err(|_| AppError::RepositoryBusy)?,
            None => lock.lock_owned().await,
        };
        self.check(&key)?;
        Ok(RepositoryGuard { key, _guard: guard })
    }
}
