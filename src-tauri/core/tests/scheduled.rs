use std::path::Path;
use std::process::Command;

use gitverse_core::git::{
    scheduled_git, GitRunner, RunOpts, ScheduledGitAction, ScheduledGitResult,
};

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

#[tokio::test]
async fn scheduled_actions_fetch_pull_and_skip_unsafe_repositories() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let source = root.join("source");
    let repo = root.join("repo");
    git(
        root,
        &["init", "--quiet", "--initial-branch=main", "source"],
    );
    git(&source, &["config", "user.name", "Test User"]);
    git(&source, &["config", "user.email", "test@example.com"]);
    std::fs::write(source.join("file.txt"), "one\n").unwrap();
    git(&source, &["add", "file.txt"]);
    git(&source, &["commit", "--quiet", "-m", "Initial"]);
    let runner = GitRunner::default();
    assert_eq!(
        scheduled_git(&runner, &source, ScheduledGitAction::Fetch, false)
            .await
            .unwrap(),
        ScheduledGitResult::Skipped {
            reason: "No remotes are configured.".into()
        }
    );
    std::fs::write(
        source.join(".git").join("MERGE_HEAD"),
        format!("{}\n", git(&source, &["rev-parse", "HEAD"])),
    )
    .unwrap();
    assert_eq!(
        scheduled_git(&runner, &source, ScheduledGitAction::Fetch, false)
            .await
            .unwrap(),
        ScheduledGitResult::Skipped {
            reason: "A Git operation is in progress.".into()
        }
    );
    std::fs::remove_file(source.join(".git").join("MERGE_HEAD")).unwrap();
    git(root, &["clone", "--quiet", "source", "repo"]);
    std::fs::write(source.join("file.txt"), "two\n").unwrap();
    git(&source, &["commit", "--quiet", "-am", "Update"]);
    assert_eq!(
        scheduled_git(&runner, &repo, ScheduledGitAction::Fetch, false)
            .await
            .unwrap(),
        ScheduledGitResult::Success
    );
    assert_eq!(
        scheduled_git(&runner, &repo, ScheduledGitAction::Pull, false)
            .await
            .unwrap(),
        ScheduledGitResult::Success
    );
    assert_eq!(
        git(&source, &["rev-parse", "HEAD"]),
        git(&repo, &["rev-parse", "HEAD"])
    );
    std::fs::write(repo.join("file.txt"), "uncommitted\n").unwrap();
    assert_eq!(
        scheduled_git(&runner, &repo, ScheduledGitAction::Pull, false)
            .await
            .unwrap(),
        ScheduledGitResult::Skipped {
            reason: "The working tree has local changes.".into()
        }
    );
    git(&repo, &["restore", "file.txt"]);
    git(&repo, &["checkout", "--quiet", "--detach"]);
    assert_eq!(
        scheduled_git(&runner, &repo, ScheduledGitAction::Pull, false)
            .await
            .unwrap(),
        ScheduledGitResult::Skipped {
            reason: "HEAD is detached.".into()
        }
    );
    git(&repo, &["checkout", "--quiet", "-b", "no-upstream"]);
    assert_eq!(
        scheduled_git(&runner, &repo, ScheduledGitAction::Pull, false)
            .await
            .unwrap(),
        ScheduledGitResult::Skipped {
            reason: "The current branch has no upstream.".into()
        }
    );
    git(&repo, &["checkout", "--quiet", "main"]);
    git(&repo, &["config", "user.name", "Test User"]);
    git(&repo, &["config", "user.email", "test@example.com"]);
    std::fs::write(repo.join("local.txt"), "local\n").unwrap();
    git(&repo, &["add", "local.txt"]);
    git(&repo, &["commit", "--quiet", "-m", "Local"]);
    std::fs::write(source.join("remote.txt"), "remote\n").unwrap();
    git(&source, &["add", "remote.txt"]);
    git(&source, &["commit", "--quiet", "-m", "Remote"]);
    let before = git(&repo, &["rev-parse", "HEAD"]);
    assert_eq!(
        scheduled_git(&runner, &repo, ScheduledGitAction::Pull, false)
            .await
            .unwrap(),
        ScheduledGitResult::Skipped {
            reason: "The current branch cannot be fast-forwarded.".into()
        }
    );
    assert_eq!(git(&repo, &["rev-parse", "HEAD"]), before);
    let remote = root.join("sensitive-remote-name");
    git(
        &repo,
        &["remote", "set-url", "origin", remote.to_str().unwrap()],
    );
    assert_eq!(
        scheduled_git(&runner, &repo, ScheduledGitAction::Fetch, false)
            .await
            .unwrap_err()
            .to_string(),
        "Scheduled fetch failed. Check the repository, network, and credentials."
    );
}

#[tokio::test]
async fn scheduled_errors_do_not_expose_git_output() {
    let error = scheduled_git(
        &GitRunner::default(),
        Path::new("/path/that/does/not/exist"),
        ScheduledGitAction::Fetch,
        false,
    )
    .await
    .unwrap_err();
    assert_eq!(
        error.to_string(),
        "Scheduled fetch failed. Check the repository, network, and credentials."
    );
}

#[cfg(unix)]
#[tokio::test]
async fn timeout_terminates_git_descendants() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let fake_git = temp.path().join("git");
    std::fs::write(
        &fake_git,
        "#!/bin/sh\n(/bin/sleep 1; echo survived > survived) &\nwait\n",
    )
    .unwrap();
    std::fs::set_permissions(&fake_git, std::fs::Permissions::from_mode(0o755)).unwrap();
    let error = GitRunner::new(fake_git)
        .run(
            temp.path(),
            &[],
            RunOpts {
                timeout: Some(std::time::Duration::from_millis(200)),
                process_group: true,
                ..RunOpts::default()
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(error, gitverse_core::AppError::Timeout));
    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
    assert!(!temp.path().join("survived").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn scheduled_fetch_preserves_repository_ssh_command() {
    use std::os::unix::fs::PermissionsExt;
    const CHILD: &str = "GITVERSE_SSH_TEST_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "scheduled_fetch_preserves_repository_ssh_command",
            ])
            .env(CHILD, "1")
            .env_remove("GIT_SSH_COMMAND")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    git(root, &["init", "--quiet"]);
    let ssh = root.join("ssh-test");
    std::fs::write(
        &ssh,
        "#!/bin/sh\nprintf '%s' \"$SSH_ASKPASS_REQUIRE\" > ssh-invoked\nexit 1\n",
    )
    .unwrap();
    std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
    git(
        root,
        &[
            "config",
            "core.sshCommand",
            &format!("\"{}\"", ssh.display()),
        ],
    );
    git(
        root,
        &["remote", "add", "origin", "ssh://example.invalid/repo"],
    );
    assert!(scheduled_git(
        &GitRunner::default(),
        root,
        ScheduledGitAction::Fetch,
        false
    )
    .await
    .is_err());
    assert_eq!(
        std::fs::read_to_string(root.join("ssh-invoked")).unwrap(),
        "never"
    );
}
