//! Choose a release for a new deployment and retain an existing deployment's exact version.
//!
//! A new deployment fetches this build's own release when there is one, and the latest release only
//! when there is not: see `resolve_version` and `resolve_version_of_this_build`.

use std::path::Path;

use serde::Deserialize;

use crate::deployment;

const LATEST_RELEASE: &str = "https://api.github.com/repos/DamonZS/CCP-Bot/releases/latest";

/// The version this build is.
///
/// Read from the root manifest at compile time — the same file the bundler reads — so what is
/// bundled and what is fetched come from one number and a build cannot disagree with itself.
pub fn own_version() -> String {
    #[derive(Deserialize)]
    struct Manifest {
        version: String,
    }

    let manifest: Manifest = serde_json::from_str(include_str!("../../../package.json"))
        .expect("the root package.json is part of this build");
    manifest.version.trim().to_string()
}

/// The tag this build's own release would carry.
pub fn own_tag() -> String {
    format!("v{}", own_version())
}

/// Only new deployments consult GitHub. The fetcher records the exact tag after the source and
/// image manifest have both downloaded successfully; restarts and repairs retain that pin.
/// Uses blocking HTTP, so callers in an async runtime must use a blocking task.
///
/// A new deployment fetches **this build's own release**, not whatever "latest" happens to name. A
/// build that fetches the latest release and then runs it with this tree's own route makes two
/// versions prove each other: 0.4.0's steps on 0.3.2's sources is how a machine that had never
/// installed CCP-Bot this way ended up with a stack that never answered. Only when this version has
/// no release of its own — a build from `main`, or a version whose release was never published —
/// does it fall back to the latest, which is at least a set of sources that exists.
pub fn resolve_version(root: &Path) -> Result<String, String> {
    resolve_version_with(root, || {
        resolve_version_of_this_build(
            &own_tag(),
            |tag| deployment::get(&deployment::images_url(tag)),
            latest_release,
        )
    })
}

/// Chooses between this build's own release and the latest one.
///
/// "This version has no release" and "the lookup failed" are two different answers, and are not
/// treated as one here: a rate limit, an offline machine or a 5xx is reported as it arrived, so
/// nobody is sent to a different version by a network problem. A release counts as published when
/// the release itself answers: the lookup is the release-by-tag endpoint, and the image manifest
/// inside it is only the container route's business, so a tag whose manifest is not attached yet is
/// still this build's release.
fn resolve_version_of_this_build(
    own: &str,
    look_up: impl FnOnce(&str) -> Result<Vec<u8>, String>,
    latest: impl FnOnce() -> Result<String, String>,
) -> Result<String, String> {
    match look_up(own) {
        Ok(_released) => Ok(own.to_string()),
        Err(error) if no_such_release(&error) => latest(),
        Err(error) => Err(error),
    }
}

/// Whether the release this build's tag names exists.
///
/// The live tests ask this before they download anything: while this version is not published there
/// is nothing on GitHub that matches this tree's route, and a test that fetched the latest release
/// instead would be measuring a version this code will never run. A lookup that failed is an error
/// rather than a no. What it probes is the release itself, not the image manifest, so the minutes
/// between the installers being attached and the manifest being attached still answer yes.
pub fn own_release_is_published() -> Result<bool, String> {
    own_release_state(|tag| deployment::get(&deployment::images_url(tag)))
}

fn own_release_state(
    look_up: impl FnOnce(&str) -> Result<Vec<u8>, String>,
) -> Result<bool, String> {
    match look_up(&own_tag()) {
        Ok(_released) => Ok(true),
        Err(error) if no_such_release(&error) => Ok(false),
        Err(error) => Err(error),
    }
}

/// Whether an answer says the release is not there at all.
///
/// The one place that reads a status out of `deployment::get`'s message: 404 means there is no such
/// release, and everything else — 403 from an anonymous rate limit, 5xx, an unreachable host — is a
/// failed lookup that must not be mistaken for it.
fn no_such_release(error: &str) -> bool {
    error.contains(" answered 404")
}

fn latest_release() -> Result<String, String> {
    let body = deployment::get(LATEST_RELEASE)
        .map_err(|error| format!("could not find the latest CCP-Bot release: {error}"))?;
    release_tag(&body)
}

fn resolve_version_with(
    root: &Path,
    latest: impl FnOnce() -> Result<String, String>,
) -> Result<String, String> {
    match deployment::installed(root) {
        Some(installed) => Ok(installed.version),
        None => latest(),
    }
}

fn release_tag(body: &[u8]) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Release {
        tag_name: String,
    }

    let release: Release = serde_json::from_slice(body)
        .map_err(|error| format!("the latest CCP-Bot release is not readable: {error}"))?;
    if release.tag_name.trim().is_empty() {
        return Err("the latest CCP-Bot release has no version tag".into());
    }
    Ok(release.tag_name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_root;

    fn scratch(label: &str) -> std::path::PathBuf {
        let root = temp_root(label);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn this_build_is_the_version_its_manifest_names() {
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../../package.json")).unwrap();
        let version = manifest["version"].as_str().unwrap();
        assert_eq!(own_version(), version);
        assert_eq!(own_tag(), format!("v{version}"));
        assert!(!own_version().is_empty());
    }

    #[test]
    fn a_new_deployment_fetches_this_builds_own_release() {
        let own = own_tag();
        let version = resolve_version_of_this_build(
            &own,
            |tag| {
                assert_eq!(tag, own);
                Ok(br#"{"assets":[]}"#.to_vec())
            },
            || panic!("a published build must not go looking for the latest release"),
        )
        .unwrap();
        assert_eq!(version, own);
    }

    #[test]
    fn a_version_with_no_release_of_its_own_falls_back_to_the_latest() {
        let version = resolve_version_of_this_build(
            "v9.9.9",
            |_| {
                Err("https://api.github.com/repos/DamonZS/CCP-Bot/releases/tags/v9.9.9 answered 404 Not Found".into())
            },
            || Ok("v0.3.2".into()),
        )
        .unwrap();
        assert_eq!(version, "v0.3.2");
    }

    #[test]
    fn a_lookup_that_failed_is_not_a_version_without_a_release() {
        let error = resolve_version_of_this_build(
            "v9.9.9",
            |_| {
                Err("https://api.github.com/repos/DamonZS/CCP-Bot/releases/tags/v9.9.9 answered 403 Forbidden".into())
            },
            || panic!("a rate limit must not send a machine to another version"),
        )
        .expect_err("a failed lookup is reported");
        assert!(error.contains("403"), "{error}");
    }

    #[test]
    fn an_unpublished_build_is_told_apart_from_a_lookup_that_failed() {
        assert!(own_release_state(|_| Ok(br#"{"assets":[]}"#.to_vec())).unwrap());
        assert!(!own_release_state(|_| Err("the release answered 404 Not Found".into())).unwrap());
        let error = own_release_state(|_| Err("the release answered 403 Forbidden".into()))
            .expect_err("a failed lookup is an error here too");
        assert!(error.contains("403"), "{error}");
    }

    #[test]
    fn a_fresh_install_asks_for_a_version_without_recording_an_unfinished_download() {
        let root = scratch("release-fresh");
        let version = resolve_version_with(&root, || Ok("v0.0.9".into())).unwrap();
        assert_eq!(version, "v0.0.9");
        assert!(deployment::installed(&root).is_none());
        assert!(deployment::needs_fetch(&root, &version));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_installed_version_does_not_query_github_or_upgrade() {
        let root = scratch("release-installed");
        deployment::record(&root, "v0.0.7").unwrap();
        std::fs::write(deployment::images_path(&root), "{}").unwrap();
        let version = resolve_version_with(&root, || panic!("must work offline")).unwrap();
        assert_eq!(version, "v0.0.7");
        assert!(!deployment::needs_fetch(&root, &version));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_missing_manifest_repairs_the_pinned_version() {
        let root = scratch("release-repair");
        deployment::record(&root, "v0.0.7").unwrap();
        let version = resolve_version_with(&root, || panic!("keep the installed pin")).unwrap();
        assert_eq!(version, "v0.0.7");
        assert!(deployment::needs_fetch(&root, &version));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_failed_lookup_is_reported_without_recording_a_version() {
        let root = scratch("release-lookup-failed");
        let error = resolve_version_with(&root, || Err("GitHub answered 403".into()))
            .expect_err("a failed lookup must not fall back to an old release");
        assert!(error.contains("403"));
        assert!(deployment::installed(&root).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn githubs_exact_tag_is_used_instead_of_the_release_title() {
        assert_eq!(
            release_tag(br#"{"name":"CCP-Bot September release","tag_name":"v0.0.9"}"#).unwrap(),
            "v0.0.9"
        );
    }

    #[test]
    fn missing_or_unreadable_release_metadata_is_refused() {
        for body in [b"not json".as_slice(), b"{}", br#"{"tag_name":" "}"#] {
            assert!(release_tag(body).is_err());
        }
    }

    /// Exercises the production resolver and downloader against GitHub in an empty directory: the
    /// release this build's own tag names, which is the one a new deployment installs.
    #[test]
    #[ignore = "downloads this build's own release from GitHub"]
    fn live_the_release_this_build_names_is_downloaded_and_pinned() {
        let root = scratch("release-live");
        let version = resolve_version(&root).expect("resolve this build's release");
        assert!(deployment::installed(&root).is_none());
        deployment::fetch(&root, &version, true)
            .expect("download the tagged deployment and manifest");
        assert_eq!(deployment::installed(&root).unwrap().version, version);
        let images: deployment::Images =
            serde_json::from_slice(&std::fs::read(deployment::images_path(&root)).unwrap())
                .unwrap();
        assert_eq!(images.version, version);
        let package: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join("package.json")).unwrap()).unwrap();
        assert_eq!(package["version"], version.trim_start_matches('v'));
        for path in deployment::REQUIRED {
            assert!(root.join(path).exists(), "missing {path}");
        }
        assert_eq!(
            resolve_version_with(&root, || panic!("restart must not need GitHub")).unwrap(),
            version
        );
        assert!(!deployment::needs_fetch(&root, &version));
        println!("Downloaded and pinned {version}; tagged source, image manifest, and offline reuse verified.");
        std::fs::remove_dir_all(root).unwrap();
    }
}
