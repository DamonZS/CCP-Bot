//! Running CCP-Bot as ordinary programs on this machine.
//!
//! Why this exists: the container route needs a container engine, and on Windows that engine is a
//! virtual machine with its own installer, its own terms page and — for the WSL half of it —
//! administrator rights. Somebody who downloaded an installer for a desktop application should not
//! have to pass any of that. Everything here is instead ordinary files in the app's own folder and
//! ordinary child processes: a portable PostgreSQL, the runtime the app already knows how to fetch,
//! and `bun` running the server and the worker out of the checkout.
//!
//! The layout under the root folder:
//!
//! ```text
//! postgres/pgsql/bin/initdb.exe     the portable build, unpacked once
//! postgres/data/                    the cluster, initialised once and reused
//! postgres/port                     the port the cluster was told to listen on
//! logs/local-*.log                  one file per process, appended across runs
//! .env                              the database and page settings, merged into whatever is there
//! app/dist                          the interface, built once from the checkout
//! ```
//!
//! Two deliberate choices worth knowing when reading the code below:
//!
//! - The database listens on `127.0.0.1` only, and `initdb` is asked for `trust` authentication.
//!   That is not a shortcut around a password: a cluster that cannot be reached from another
//!   machine has no use for one, and asking for one would mean a second secret to store and get
//!   wrong. The container route's `ccpbot:ccpbot` pair stays as it is.
//! - The PostgreSQL download is pinned by digest, like the deployment pins image digests. A version
//!   is what somebody hoped would be served; the digest is what was actually unpacked and run.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

use crate::install::{self, Download};
use crate::problem::Problem;
use crate::quiet;

/// The portable PostgreSQL this is built against: EDB's Windows binaries zip, which needs no
/// installer and no administrator — unzip it anywhere and it runs.
#[cfg(windows)]
pub const POSTGRES_URL: &str =
    "https://get.enterprisedb.com/postgresql/postgresql-17.6-1-windows-x64-binaries.zip";
#[cfg(windows)]
pub const POSTGRES_ARCHIVE: &str = "postgresql-17.6-1-windows-x64-binaries.zip";

/// What that archive has to hash to before anything is unpacked or run.
///
/// Fetched and measured on a real machine: 329,891,687 bytes, and the first attempt at downloading
/// it was cut short by the server, which is exactly the sort of thing a digest catches.
pub const POSTGRES_SHA256: &str =
    "d378882abd001a186735acd6f6ba716bca6ccd192e800412d4fd15ed25376b3e";

pub const POSTGRES_FOLDER: &str = "postgres";
/// What the EDB archive holds at its top level, so that is where unpacking leaves the binaries.
pub const POSTGRES_UNPACKED: &str = "pgsql";

/// The pgvector build for the portable server above, from the Windows binaries the extension's own
/// documentation points at.
///
/// The first migration is `CREATE EXTENSION IF NOT EXISTS vector;`, and the EDB build does not
/// bundle the extension — a container gets it from the `pgvector/pgvector` image, a machine running
/// PostgreSQL itself has to be handed one. Without it the very first migration stops with
/// `extension "vector" is not available`, and nothing after it runs.
#[cfg(windows)]
pub const VECTOR_URL: &str =
    "https://github.com/andreiramani/pgvector_pgsql_windows/releases/download/0.8.6_17/vector.v0.8.6-pg17.zip";
#[cfg(windows)]
pub const VECTOR_ARCHIVE: &str = "vector.v0.8.6-pg17.zip";

/// What that archive has to hash to: 169,689 bytes, measured on the same machine.
pub const VECTOR_SHA256: &str = "420388e9e9f05d92f06d6967ce8772483629b27a66ca9255925fa0fdd445438e";

/// Where the extension archive is unpacked before its files are placed into the server.
pub const VECTOR_FOLDER: &str = "pgvector";
/// The file the server looks for to know the extension exists.
pub const VECTOR_CONTROL: &str = "vector.control";
pub const DATA_FOLDER: &str = "data";
pub const PORT_FILE: &str = "port";
pub const LOGS_FOLDER: &str = "logs";
pub const SERVER_ADDRESS: &str = "http://127.0.0.1:3010";
/// The port the interface is served on, and the one the server is told about through `.env`.
pub const SERVER_PORT: u16 = 3010;
pub const DATABASE_USER: &str = "ccpbot";
pub const DATABASE_NAME: &str = "ccpbot";

/// The built-in Bot, the one agent every install has whether or not somebody installs another.
///
/// Started from the checkout root and pointed at by the server through `MANAGED_AGENT_AG_UI_URL`.
/// Without it a deployment has no Bot at all, and the window would offer one it cannot run — the one
/// thing an install that promises to work on this computer must not do.
pub const BOT_ENTRY: &str = "agent-bot/src/index.ts";
pub const BOT_FOLDER: &str = "bot";
pub const BOT_PORT_FILE: &str = "port";

/// The computer: the process that does a Bot's file writes and runs its commands.
///
/// A Bot with no computer can talk and cannot touch anything — it cannot open the project this
/// person is looking at, which is the whole difference between a chat window and a colleague. The
/// container route gives every Bot one made by the supervisor; local mode runs one itself, as a
/// program on this machine, with its workspace pointed at a folder here.
pub const COMPUTER_ENTRY: &str = "agent-computer/src/index.ts";
pub const COMPUTER_FOLDER: &str = "computer";
pub const COMPUTER_PORT_FILE: &str = "port";
/// The folder a Bot works in when nobody has pointed local mode at one of their own.
pub const WORKSPACE_FOLDER: &str = "workspace";
/// The one-line file holding the folder this person chose instead.
///
/// A file rather than a setting buried in the app's data: it sits beside the workspace it names, it
/// can be read and changed with a text editor, and deleting it puts the default back.
pub const WORKSPACE_FILE: &str = "workspace.txt";
/// Where Playwright keeps the browser the computer launches for a Bot that needs a page.
pub const BROWSERS_FOLDER: &str = "browsers";

/// The health check gets a long time on a first run: the interface may still be building and the
/// worker is starting up beside it.
pub const HEALTH_TIMEOUT: Duration = Duration::from_secs(120);
/// `pg_ctl -w` waits this long for the cluster, which is longer than a first start needs.
pub const POSTGRES_TIMEOUT: Duration = Duration::from_secs(90);
/// The Bot answers quickly — it has nothing to build — but it installs its own dependencies on the
/// very first run of a fresh checkout, so it is not given the same hurry as a health probe.
pub const BOT_TIMEOUT: Duration = Duration::from_secs(90);
/// The computer has a little more to do on a first run than the Bot does: it installs its own
/// dependencies and, the first time, fetches the browser it launches for a Bot that needs a page.
pub const COMPUTER_TIMEOUT: Duration = Duration::from_secs(120);
const HEALTH_INTERVAL: Duration = Duration::from_millis(500);

/// The keys in `.env` this mode owns. Everything else in the file is left exactly as it was, which
/// matters: the same file carries the person's own provider and intelligence settings.
pub const MANAGED_KEYS: [&str; 10] = [
    "DATABASE_URL",
    "PORT",
    "SERVER_PORT",
    "APP_DIST_DIR",
    "CCPBOT_SINGLE_USER",
    "SERVER_INTERNAL_URL",
    "MANAGED_AGENT_AG_UI_URL",
    // Where the server finds the computer that does a Bot's work. The container route names a
    // service; here it is a process on the loopback address, written before the server starts
    // because the server reads it once and has no second chance at it.
    "AGENT_COMPUTER_URL",
    // `server/src/config.ts` refuses private addresses unless this is true, and everything in a
    // local deployment is at a private address on purpose. Compose gets the same effect by leaving
    // `NODE_ENV` empty.
    "AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS",
    "NODE_ENV",
];

/// The CopilotKit Intelligence connection a local run answers for itself.
///
/// `server/src/config.ts` refuses to start without a URL, a gateway address and a key, and it has no
/// way of knowing that a desktop install has no CopilotKit account behind it: the agent a local run
/// actually talks to is the built-in Bot on the loopback address. These three values are what
/// satisfies that check — the ones the ignored live test has always used — and nothing here needs
/// them to answer. That the stack comes up with `http://127.0.0.1:9/api` as its Intelligence URL is
/// measured, not assumed: the live test below starts the whole thing with exactly these values.
///
/// Somebody's own connection is never replaced. See `server_environment`.
pub const LOCAL_INTELLIGENCE: [(&str, &str); 3] = [
    ("INTELLIGENCE_API_URL", "http://127.0.0.1:9/api"),
    ("INTELLIGENCE_GATEWAY_WS_URL", "ws://127.0.0.1:9/gateway"),
    (
        "INTELLIGENCE_API_KEY",
        "sk-local-placeholder-for-a-desktop-run",
    ),
];

/// The archive to unpack for this platform, or why there is not one.
///
/// Only Windows is wired up. The packages exist elsewhere, but each platform's archive is a
/// different shape and none of them has been run here, so the honest answer for now is that the
/// container route is the one to use.
pub fn postgres() -> Result<Download, Problem> {
    #[cfg(windows)]
    {
        return Ok(Download {
            url: POSTGRES_URL.to_string(),
            sha256: POSTGRES_SHA256,
            file: POSTGRES_ARCHIVE,
        });
    }
    #[cfg(not(windows))]
    {
        Err(Problem::with(
            "Local mode ships a portable database for Windows only.",
            format!(
                "no portable PostgreSQL is wired up for {} on {}",
                std::env::consts::OS,
                std::env::consts::ARCH
            ),
        ))
    }
}

pub fn postgres_folder(root: &Path) -> PathBuf {
    root.join(POSTGRES_FOLDER)
}

pub fn unpacked_folder(root: &Path) -> PathBuf {
    postgres_folder(root).join(POSTGRES_UNPACKED)
}

pub fn bin_folder(root: &Path) -> PathBuf {
    unpacked_folder(root).join("bin")
}

pub fn data_folder(root: &Path) -> PathBuf {
    postgres_folder(root).join(DATA_FOLDER)
}

/// Where the chosen database port is kept, so a restart connects to the cluster it left behind.
pub fn port_file(root: &Path) -> PathBuf {
    postgres_folder(root).join(PORT_FILE)
}

pub fn logs_folder(root: &Path) -> PathBuf {
    root.join(LOGS_FOLDER)
}

/// Where the bundled Bot's chosen port is kept.
///
/// Its own folder rather than the database's: the two numbers are unrelated, and a folder per
/// process is also where a second Bot would go if this mode ever runs one.
pub fn bot_folder(root: &Path) -> PathBuf {
    root.join(BOT_FOLDER)
}

pub fn bot_port_file(root: &Path) -> PathBuf {
    bot_folder(root).join(BOT_PORT_FILE)
}

pub fn log_file(root: &Path, name: &str) -> PathBuf {
    logs_folder(root).join(format!("local-{name}.log"))
}

/// One of PostgreSQL's own programs, from the unpacked archive.
pub fn tool(root: &Path, name: &str) -> PathBuf {
    let file = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    bin_folder(root).join(file)
}

/// The connection string for a cluster that only listens on the loopback address.
pub fn database_url(port: u16) -> String {
    format!("postgres://{DATABASE_USER}@127.0.0.1:{port}/{DATABASE_NAME}")
}

/// A port nothing is listening on, asked of the operating system rather than guessed.
pub fn free_port() -> Result<u16, Problem> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| {
        Problem::with(
            "Local mode could not find a free port.",
            format!("binding 127.0.0.1:0 failed: {error}"),
        )
    })?;
    let port = listener.local_addr().map_err(|error| {
        Problem::with(
            "Local mode could not find a free port.",
            format!("the bound socket has no address: {error}"),
        )
    })?;
    drop(listener);
    Ok(port.port())
}

/// The database port: the one used before if there is one, a new one otherwise.
///
/// Remembered rather than picked fresh each time, because the same value also goes into
/// `DATABASE_URL` in `.env` — a port that changed on every start would rewrite that line every time
/// and break anything that connected a moment earlier.
/// The port this folder's database was given, once one has been chosen.
///
/// Read rather than chosen, so asking about a folder that has never run cannot create the file that
/// says it has.
pub fn remembered_port(root: &Path) -> Option<u16> {
    std::fs::read_to_string(port_file(root))
        .ok()
        .and_then(|text| text.trim().parse::<u16>().ok())
        .filter(|port| *port > 0)
}

pub fn database_port(root: &Path) -> Result<u16, Problem> {
    let file = port_file(root);
    if let Ok(text) = std::fs::read_to_string(&file) {
        if let Ok(port) = text.trim().parse::<u16>() {
            if port > 0 {
                return Ok(port);
            }
        }
    }
    let port = free_port()?;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            Problem::with(
                "Local mode could not store the database port.",
                format!("creating {} failed: {error}", parent.display()),
            )
        })?;
    }
    std::fs::write(&file, format!("{port}\n")).map_err(|error| {
        Problem::with(
            "Local mode could not store the database port.",
            format!("writing {} failed: {error}", file.display()),
        )
    })?;
    Ok(port)
}

/// The port the bundled Bot was given, once one has been chosen.
///
/// Read rather than chosen, for the same reason the database's is: `MANAGED_AGENT_AG_UI_URL` in
/// `.env` names this port, and an address that changed on every start would leave the server
/// pointing at a Bot that is not there.
pub fn remembered_bot_port(root: &Path) -> Option<u16> {
    std::fs::read_to_string(bot_port_file(root))
        .ok()
        .and_then(|text| text.trim().parse::<u16>().ok())
        .filter(|port| *port > 0)
}

pub fn bot_port(root: &Path) -> Result<u16, Problem> {
    if let Some(port) = remembered_bot_port(root) {
        return Ok(port);
    }
    let port = free_port()?;
    let file = bot_port_file(root);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            Problem::with(
                "Local mode could not store the Bot port.",
                format!("creating {} failed: {error}", parent.display()),
            )
        })?;
    }
    std::fs::write(&file, format!("{port}\n")).map_err(|error| {
        Problem::with(
            "Local mode could not store the Bot port.",
            format!("writing {} failed: {error}", file.display()),
        )
    })?;
    Ok(port)
}

/// Where the bundled Bot lives in this checkout, when this checkout has one.
///
/// The entry file, not the folder: `agent-bot/` without `src/index.ts` holds nothing runnable, and
/// the two questions are the same question to everyone who asks it.
pub fn bot_entry(root: &Path) -> Option<PathBuf> {
    let entry = root.join(BOT_ENTRY);
    entry.is_file().then_some(entry)
}

/// The arguments that start the bundled Bot from the checkout root.
///
/// From the root, not from `agent-bot/`: the entry file imports `../../shared/agent-authorisation`
/// and `../../shared/model-providers`, which resolve only when the process is started where the
/// repository is — the image preserves the layout for exactly this reason. `.env` is read through
/// `--env-file`, so the model key the wizard collected reaches the Bot the same way it reaches the
/// server, instead of being copied here.
pub fn bot_arguments() -> Vec<String> {
    vec!["--env-file=.env".to_string(), BOT_ENTRY.to_string()]
}

/// The address the server reaches the bundled Bot on.
pub fn bot_address(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// What the bundled Bot needs in its environment, and nothing else.
///
/// Its token first: the process holds a model credential and refuses to start without one
/// (`agent-bot/src/index.ts` exits when the variable is absent). Its port second. The model key and
/// any relay address come from `.env`, which is where the wizard already put them.
pub fn bot_environment(port: u16, secrets: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    [
        ("PORT", port.to_string()),
        (
            "MANAGED_AGENT_TOKEN",
            secrets
                .get("MANAGED_AGENT_TOKEN")
                .cloned()
                .unwrap_or_default(),
        ),
    ]
    .into_iter()
    .map(|(name, value)| (name.to_string(), value))
    .collect()
}

/// The folder a Bot does its work in.
///
/// The person's own answer first — `workspace.txt` beside the checkout, holding one absolute path —
/// and a folder of our own otherwise. A file rather than a setting in the app's data so that pointing
/// a Bot at a project is something a person can do by editing one line, and undoing it is deleting
/// the same line.
pub fn workspace_folder(root: &Path) -> PathBuf {
    let pointer = root.join(WORKSPACE_FILE);
    let chosen = std::fs::read_to_string(&pointer)
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
        .map(PathBuf::from);
    match chosen {
        Some(folder) => folder,
        None => root.join(WORKSPACE_FOLDER),
    }
}

/// Points local mode at a folder of the person's own, and says which one it now uses.
pub fn set_workspace_folder(root: &Path, folder: &Path) -> Result<PathBuf, Problem> {
    let pointer = root.join(WORKSPACE_FILE);
    std::fs::write(&pointer, format!("{}\n", folder.display())).map_err(|error| {
        Problem::with(
            "Local mode could not remember the working folder.",
            format!("writing {} failed: {error}", pointer.display()),
        )
    })?;
    Ok(folder.to_path_buf())
}

/// The port the computer was given, once one has been chosen. Read, never chosen: `AGENT_COMPUTER_URL`
/// in `.env` names it, and an address that changed under the server would point at nothing.
pub fn remembered_computer_port(root: &Path) -> Option<u16> {
    std::fs::read_to_string(computer_port_file(root))
        .ok()
        .and_then(|text| text.trim().parse::<u16>().ok())
        .filter(|port| *port > 0)
}

pub fn computer_port(root: &Path) -> Result<u16, Problem> {
    if let Some(port) = remembered_computer_port(root) {
        return Ok(port);
    }
    let port = free_port()?;
    let file = computer_port_file(root);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            Problem::with(
                "Local mode could not store the computer's port.",
                format!("creating {} failed: {error}", parent.display()),
            )
        })?;
    }
    std::fs::write(&file, format!("{port}\n")).map_err(|error| {
        Problem::with(
            "Local mode could not store the computer's port.",
            format!("writing {} failed: {error}", file.display()),
        )
    })?;
    Ok(port)
}

pub fn computer_folder(root: &Path) -> PathBuf {
    root.join(COMPUTER_FOLDER)
}

pub fn computer_port_file(root: &Path) -> PathBuf {
    computer_folder(root).join(COMPUTER_PORT_FILE)
}

/// Where the computer's own files live: its browsers, kept out of the workspace a Bot may delete.
pub fn browsers_folder(root: &Path) -> PathBuf {
    computer_folder(root).join(BROWSERS_FOLDER)
}

/// The computer's entry file, when this checkout has one.
pub fn computer_entry(root: &Path) -> Option<PathBuf> {
    let entry = root.join(COMPUTER_ENTRY);
    entry.is_file().then_some(entry)
}

/// Whether the computer's own dependencies are installed.
///
/// `agent-computer` is deliberately not a workspace member — its image installs it on its own — so
/// its install is its own step, in its own folder.
pub fn computer_dependencies_installed(root: &Path) -> bool {
    root.join("agent-computer").join("node_modules").is_dir()
}

/// Whether the Bot's own dependencies are installed.
///
/// `agent-bot` is deliberately not a workspace member either, so the root `bun install` never
/// touches it and its install is its own step, in its own folder.
///
/// A development checkout hides how load-bearing that step is: it is hoisted, so `@ag-ui/encoder`
/// sits at the top level regardless — at 1.0.2, a version `agent-bot/package.json` never asked for,
/// since it declares 0.0.57 — and `agent-bot/src/index.ts` resolves it by accident. The isolated
/// layout a deployment installs has no such entry, so the Bot dies before its first request with
/// `Cannot find module '@ag-ui/encoder'`.
pub fn bot_dependencies_installed(root: &Path) -> bool {
    root.join("agent-bot").join("node_modules").is_dir()
}

/// The address the server reaches the computer on.
pub fn computer_address(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// What the computer needs in its environment.
///
/// The token the server calls it with, its port, the folder a Bot works in, where its profiles and
/// browsers go, and no `COMPUTER_PEOPLE_ONLY`: that flag marks a computer that runs the person's own
/// browser instead of a Bot's work (`local_browser.rs` uses it for exactly that), and a computer
/// marked that way is not the one a Bot is given.
///
/// `WORKSPACE_DIR` is the whole point of this process in local mode: it is the folder on this machine
/// the Bot may read, write and run commands in, and `agent-computer/src/workspace.ts` confines every
/// path to it.
pub fn computer_environment(
    root: &Path,
    port: u16,
    secrets: &BTreeMap<String, String>,
    workspace: &Path,
) -> BTreeMap<String, String> {
    [
        ("PORT", port.to_string()),
        (
            "COMPUTER_TOKEN",
            secrets.get("COMPUTER_TOKEN").cloned().unwrap_or_default(),
        ),
        ("WORKSPACE_DIR", workspace.display().to_string()),
        ("COMPUTER_BOT_ID", "shared".to_string()),
        // The browser the computer launches for a Bot that needs a page, kept under this
        // deployment's own folder rather than in the account's shared Playwright cache: uninstalling
        // CCP-Bot should not silently take a browser away from something else that uses it.
        (
            "PLAYWRIGHT_BROWSERS_PATH",
            browsers_folder(root).display().to_string(),
        ),
    ]
    .into_iter()
    .map(|(name, value)| (name.to_string(), value))
    .collect()
}

/// Whether the cluster has been created already — the file `initdb` always leaves behind.
pub fn initialised(root: &Path) -> bool {
    data_folder(root).join("PG_VERSION").is_file()
}

/// Whether the portable PostgreSQL is unpacked and usable.
pub fn postgres_ready(root: &Path) -> bool {
    tool(root, "postgres").is_file() && tool(root, "initdb").is_file()
}

/// `.env` with our keys set, everything else left alone.
///
/// The keys this mode owns are replaced in place where they already exist, and appended at the end
/// where they do not. Any earlier value for a key we own is replaced rather than kept, because the
/// whole point is that the values here are the ones that describe this machine's database.
pub fn merged_env(existing: &str, values: &[(&str, String)]) -> String {
    let mut lines: Vec<String> = Vec::new();
    for line in existing.lines() {
        let trimmed = line.trim_start();
        let key = trimmed.split('=').next().unwrap_or("").trim();
        match values.iter().find(|(name, _)| *name == key) {
            Some((name, value)) => lines.push(format!("{name}={value}")),
            None => lines.push(line.to_string()),
        }
    }
    let mut written: Vec<&str> = Vec::new();
    for (name, value) in values {
        let already = lines
            .iter()
            .any(|line| line.trim_start().split('=').next().unwrap_or("").trim() == *name);
        if already {
            continue;
        }
        if written.is_empty() {
            lines.push(String::new());
            lines.push("# Written by CCP-Bot local mode.".to_string());
        }
        lines.push(format!("{name}={value}"));
        written.push(name);
    }
    let mut text = lines.join("\n");
    text.push('\n');
    text
}

/// The secrets this deployment needs, minted once and kept in the credential store.
///
/// Measured on a real machine: without this the server refuses to start with
/// `KEY_ENCRYPTION_KEY must be configured` (it decrypts everything it stores with that key, so there
/// is nothing sensible to do without one). The other five are the tokens the parts of the stack share
/// with each other. The container route keeps these in the vault rather than in `.env`; the local
/// route does the same and hands them to its children as environment, so no file a person can open
/// carries a secret — and a restart reuses what the first run minted rather than rotating it, which
/// would make everything already encrypted unreadable.
pub fn deployment_secrets(root: &Path) -> Result<BTreeMap<String, String>, Problem> {
    let kept = crate::vault::already_given_no_ui(root, &root.join(".env"), &crate::env::MINTED)?;
    let secrets = crate::env::minted(&kept);
    for (key, value) in &secrets {
        if kept.get(key) == Some(value) {
            continue;
        }
        crate::vault::remember(root, key, value)?;
    }
    Ok(secrets)
}

/// The arguments every local service is started with: one file, so there is one place the settings
/// live, rather than a second copy in the environment of each child.
pub fn service_arguments(environment_file: &str, entry: &str) -> Vec<String> {
    vec![format!("--env-file={environment_file}"), entry.to_string()]
}

/// Fetches and unpacks the portable PostgreSQL, once.
pub fn ensure_postgres(root: &Path, cache: &Path) -> Result<PathBuf, Problem> {
    ensure_postgres_with(root, cache, install::fetch_verified)
}

/// The same, with the download passed in, so that "already unpacked" can be tested without a
/// network and a failing download can be tested without breaking one.
fn ensure_postgres_with(
    root: &Path,
    cache: &Path,
    fetch: impl Fn(&Download, &Path) -> Result<PathBuf, Problem>,
) -> Result<PathBuf, Problem> {
    if postgres_ready(root) {
        return Ok(bin_folder(root));
    }
    let download = postgres()?;
    // The archive lives in the same download cache the engine's installers use, so one folder holds
    // everything this app ever fetched and clearing it is a complete reset of that.
    let archive = fetch(&download, &crate::acquire::download_dir(cache))?;
    let destination = postgres_folder(root);
    std::fs::create_dir_all(&destination).map_err(|error| {
        Problem::with(
            "Local mode could not create its database folder.".to_string(),
            format!("creating {} failed: {error}", destination.display()),
        )
    })?;
    unpack(&archive, &destination)?;
    if !postgres_ready(root) {
        return Err(Problem::with(
            "The unpacked database has no program in it.".to_string(),
            format!(
                "{} produced no bin/postgres under {}",
                archive.display(),
                destination.display()
            ),
        ));
    }
    Ok(bin_folder(root))
}

/// The pgvector archive, on the one platform this mode serves.
#[cfg(windows)]
pub fn vector() -> Result<Download, Problem> {
    Ok(Download {
        url: VECTOR_URL.to_string(),
        sha256: VECTOR_SHA256,
        file: VECTOR_ARCHIVE,
    })
}

/// Local mode is Windows-only for now: the portable database is a Windows build, and so is the
/// extension placed beside it.
#[cfg(not(windows))]
pub fn vector() -> Result<Download, Problem> {
    Err(Problem::with(
        "Running CCP-Bot on this computer is not implemented here yet.".to_string(),
        "the portable database and its extension are Windows builds for now".to_string(),
    ))
}

/// Where the server keeps the libraries it loads: `lib/` beside it, as in any PostgreSQL install.
pub fn lib_folder(root: &Path) -> PathBuf {
    unpacked_folder(root).join("lib")
}

/// Where the server looks for extensions: one control file and its scripts per extension.
pub fn extension_folder(root: &Path) -> PathBuf {
    unpacked_folder(root).join("share").join("extension")
}

/// Whether the portable server already carries pgvector.
pub fn vector_installed(root: &Path) -> bool {
    extension_folder(root).join(VECTOR_CONTROL).is_file()
}

/// Fetches and places pgvector into the portable server, once. Answers whether anything was done.
pub fn ensure_vector(root: &Path, cache: &Path) -> Result<bool, Problem> {
    ensure_vector_with(root, cache, install::fetch_verified)
}

/// The same, with the download passed in, so that "already placed" can be tested without a network.
fn ensure_vector_with(
    root: &Path,
    cache: &Path,
    fetch: impl Fn(&Download, &Path) -> Result<PathBuf, Problem>,
) -> Result<bool, Problem> {
    if vector_installed(root) {
        return Ok(false);
    }
    let download = vector()?;
    let archive = fetch(&download, &crate::acquire::download_dir(cache))?;
    let staging = postgres_folder(root).join(VECTOR_FOLDER);
    std::fs::create_dir_all(&staging).map_err(|error| {
        Problem::with(
            "Local mode could not create the folder for its database extension.".to_string(),
            format!("creating {} failed: {error}", staging.display()),
        )
    })?;
    unpack(&archive, &staging)?;
    place_vector(root, &staging)?;
    if !vector_installed(root) {
        return Err(Problem::with(
            "The unpacked extension has no control file in it.".to_string(),
            format!(
                "{} produced no share/extension/{}",
                archive.display(),
                VECTOR_CONTROL
            ),
        ));
    }
    Ok(true)
}

/// Puts the extension where the server looks for it: the library beside the others, the control file
/// and the upgrade scripts into the extension folder.
///
/// The archive also carries headers and a readme; nothing needs them to run the extension, so they
/// stay in the staging folder instead of being copied into the server.
pub fn place_vector(root: &Path, staging: &Path) -> Result<(), Problem> {
    copy_files(&staging.join("lib"), &lib_folder(root))?;
    copy_files(
        &staging.join("share").join("extension"),
        &extension_folder(root),
    )
}

/// Copies the files of one folder into another, creating the destination.
fn copy_files(from: &Path, to: &Path) -> Result<(), Problem> {
    std::fs::create_dir_all(to).map_err(|error| {
        Problem::with(
            "Local mode could not create its database library folder.".to_string(),
            format!("creating {} failed: {error}", to.display()),
        )
    })?;
    let entries = std::fs::read_dir(from).map_err(|error| {
        Problem::with(
            "The unpacked extension is not laid out the way it is expected to be.".to_string(),
            format!("reading {} failed: {error}", from.display()),
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            Problem::with(
                "The unpacked extension could not be read.".to_string(),
                format!("reading {} failed: {error}", from.display()),
            )
        })?;
        if !entry.path().is_file() {
            continue;
        }
        let target = to.join(entry.file_name());
        std::fs::copy(entry.path(), &target).map_err(|error| {
            Problem::with(
                "The database extension could not be placed.".to_string(),
                format!("copying {} failed: {error}", target.display()),
            )
        })?;
    }
    Ok(())
}

/// Unpack a zip with the PowerShell that ships with Windows.
///
/// `Expand-Archive` is the one unzipper certain to be on the machine. A zip crate would be a
/// dependency to keep current for a step that runs once in a machine's lifetime.
#[cfg(windows)]
fn unpack(archive: &Path, destination: &Path) -> Result<(), Problem> {
    let script = format!(
        "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
        archive.display(),
        destination.display()
    );
    let output = quiet::command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script.as_str()])
        .output()
        .map_err(|error| {
            Problem::with(
                "Unpacking the portable database failed.".to_string(),
                format!("running powershell failed: {error}"),
            )
        })?;
    if output.status.success() {
        return Ok(());
    }
    let said = quiet::said(&output.stderr);
    Err(Problem::with(
        "Unpacking the portable database failed.".to_string(),
        if said.is_empty() {
            format!("powershell exited with {:?}", output.status.code())
        } else {
            said
        },
    ))
}

#[cfg(not(windows))]
fn unpack(archive: &Path, destination: &Path) -> Result<(), Problem> {
    Err(Problem::with(
        "Unpacking is not implemented for this machine.".to_string(),
        format!(
            "cannot unpack {} into {}",
            archive.display(),
            destination.display()
        ),
    ))
}

/// Creates the cluster, once.
///
/// `-A trust` belongs with the loopback-only listener set up in `start_postgres`: a cluster nothing
/// else can reach does not need a password, and a password here would be one more thing to store.
pub fn init_cluster(root: &Path) -> Result<(), Problem> {
    let initdb = tool(root, "initdb");
    if !initdb.is_file() {
        return Err(Problem::with(
            "Local mode has no database program yet.".to_string(),
            format!("{} does not exist", initdb.display()),
        ));
    }
    let data = data_folder(root);
    let data_text = data.to_string_lossy().to_string();
    let output = quiet::command(&initdb)
        .args([
            "-D",
            data_text.as_str(),
            "-U",
            DATABASE_USER,
            "-A",
            "trust",
            "-E",
            "UTF8",
            "--no-locale",
        ])
        .output()
        .map_err(|error| {
            Problem::with(
                "Initialising the database cluster failed.".to_string(),
                format!("running initdb failed: {error}"),
            )
        })?;
    if output.status.success() {
        return Ok(());
    }
    Err(Problem::with(
        "Initialising the database cluster failed.".to_string(),
        quiet::said(&output.stderr),
    ))
}

/// The marker that says this folder is run by local mode.
///
/// A file rather than a saved setting, because it has to be readable by the Windows stage check
/// before anything has been prepared, and because "run this folder locally" is a property of the
/// folder itself: copy it somewhere and the copy is a local run just as much as the original.
pub const MARKER_FILE: &str = ".ccpbot-local";

pub fn marker(root: &Path) -> PathBuf {
    root.join(MARKER_FILE)
}

/// Whether this folder has been run locally before.
pub fn wanted(root: &Path) -> bool {
    marker(root).is_file()
}

/// Records that it has, so the next start takes the same route.
///
/// It makes the folder if it is not there yet. Choosing to run a folder locally is the moment that
/// folder comes into being: a window with nothing set up yet has no root at all, and refusing to
/// write the marker into it left that window failing before anything could be prepared.
pub fn remember(root: &Path) -> Result<(), Problem> {
    let file = marker(root);
    std::fs::create_dir_all(root)
        .and_then(|()| std::fs::write(&file, "local\n"))
        .map_err(|error| {
            Problem::with(
                "Could not remember the local choice.".to_string(),
                format!("writing {} failed: {error}", file.display()),
            )
        })
}

/// Forgets it, for a folder that should go back to the container route.
pub fn forget(root: &Path) -> Result<(), Problem> {
    match std::fs::remove_file(marker(root)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(Problem::with(
            "Could not clear the local choice.".to_string(),
            format!("removing {} failed: {error}", marker(root).display()),
        )),
    }
}

/// Whether the cluster is already answering.
pub fn postgres_running(root: &Path) -> bool {
    let data = data_folder(root);
    quiet::command(tool(root, "pg_ctl"))
        .args(["-D", data.to_string_lossy().as_ref(), "status"])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// The last few lines of a file, for the failures only the log knows about.
///
/// `pg_ctl` cannot be asked for its output (see the start below), so the reason a database refused
/// to come up is read from where it was written instead of being invented.
fn tail_of(path: &Path) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    if lines.is_empty() {
        return format!("{} holds nothing to read", path.display());
    }
    let start = lines.len().saturating_sub(6);
    lines[start..].join("\n")
}

/// Starts the cluster on the loopback address, and waits for it to accept connections.
pub fn start_postgres(root: &Path, port: u16) -> Result<(), Problem> {
    if postgres_running(root) {
        return Ok(());
    }
    let data = data_folder(root);
    let log = log_file(root, "postgres");
    if let Some(parent) = log.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            Problem::with(
                "Local mode could not create its log folder.".to_string(),
                format!("creating {} failed: {error}", parent.display()),
            )
        })?;
    }
    let data_text = data.to_string_lossy().to_string();
    let log_text = log.to_string_lossy().to_string();
    let listen = format!("-p {port} -h 127.0.0.1");
    let seconds = POSTGRES_TIMEOUT.as_secs().to_string();
    /*
     * The output goes nowhere, and that is not laziness.
     *
     * `pg_ctl start` leaves a postmaster behind, and the postmaster inherits the handles this process
     * hands to its child. Asking for `output()` therefore waits for a pipe to close that the
     * postmaster holds open for as long as it runs — a start that succeeded sits there looking like
     * a start that hung, which is exactly what it did before this was written down. The reason a
     * start failed is in the log `-l` already writes, so the failure reads that instead.
     */
    let status = quiet::command(tool(root, "pg_ctl"))
        .args([
            "-D",
            data_text.as_str(),
            "-l",
            log_text.as_str(),
            "-o",
            listen.as_str(),
            "-w",
            "-t",
            seconds.as_str(),
            "start",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| {
            Problem::with(
                "The local database would not start.".to_string(),
                format!("running pg_ctl failed: {error}"),
            )
        })?;
    if status.success() {
        return Ok(());
    }
    Err(Problem::with(
        "The local database would not start.".to_string(),
        tail_of(&log),
    ))
}

/// Stops the cluster, leaving the data in place for the next start.
pub fn stop_postgres(root: &Path) -> Result<(), Problem> {
    if !postgres_running(root) {
        return Ok(());
    }
    let data = data_folder(root);
    let data_text = data.to_string_lossy().to_string();
    let log = log_file(root, "postgres");
    // Same reason as the start above: a stopping postmaster still holds the pipes of the command
    // that asked it to stop, so waiting on them waits for the database itself.
    let status = quiet::command(tool(root, "pg_ctl"))
        .args(["-D", data_text.as_str(), "-m", "fast", "-w", "stop"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| {
            Problem::with(
                "The local database would not stop.".to_string(),
                format!("running pg_ctl failed: {error}"),
            )
        })?;
    if status.success() {
        return Ok(());
    }
    Err(Problem::with(
        "The local database would not stop.".to_string(),
        tail_of(&log),
    ))
}

/// Creates the application database. Already having one is the outcome that was wanted.
pub fn create_database(root: &Path, port: u16) -> Result<(), Problem> {
    let port_text = port.to_string();
    let output = quiet::command(tool(root, "createdb"))
        .args([
            "-h",
            "127.0.0.1",
            "-p",
            port_text.as_str(),
            "-U",
            DATABASE_USER,
            DATABASE_NAME,
        ])
        .output()
        .map_err(|error| {
            Problem::with(
                "Could not create the application database.".to_string(),
                format!("running createdb failed: {error}"),
            )
        })?;
    let said = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        quiet::said(&output.stderr)
    );
    if output.status.success() || said.contains("already exists") {
        return Ok(());
    }
    Err(Problem::with(
        "Could not create the application database.".to_string(),
        said,
    ))
}

/// Starts one service, appending its output to a log under the root.
///
/// `environment` goes into the child's environment rather than into `.env`: the vault is where this
/// deployment keeps what only it should see, and the file is the person's to read.
pub fn start_service(
    bun: &Path,
    working: &Path,
    arguments: &[String],
    log: &Path,
    environment: &BTreeMap<String, String>,
) -> Result<Child, Problem> {
    if let Some(parent) = log.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            Problem::with(
                "Local mode could not create its log folder.".to_string(),
                format!("creating {} failed: {error}", parent.display()),
            )
        })?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
        .map_err(|error| {
            Problem::with(
                "Local mode could not write its log.".to_string(),
                format!("opening {} failed: {error}", log.display()),
            )
        })?;
    let _ = writeln!(file, "\n$ bun {}", arguments.join(" "));
    let stdout = file.try_clone().map_err(|error| {
        Problem::with(
            "Local mode could not write its log.".to_string(),
            format!("duplicating the log handle failed: {error}"),
        )
    })?;
    let stderr = file.try_clone().map_err(|error| {
        Problem::with(
            "Local mode could not write its log.".to_string(),
            format!("duplicating the log handle failed: {error}"),
        )
    })?;
    quiet::command(bun)
        .args(arguments)
        .envs(environment.iter())
        .current_dir(working)
        .stdin(std::process::Stdio::null())
        .stdout(stdout)
        .stderr(stderr)
        .spawn()
        .map_err(|error| {
            Problem::with(
                format!("Starting {} failed.", arguments.join(" ")),
                format!("spawning bun in {} failed: {error}", working.display()),
            )
        })
}

/// The status code `/health` answers with, or why it could not be asked.
///
/// Written with a socket rather than an HTTP client because this runs before anything is known to
/// be up, on the one address the shell controls, and a request that cannot hang matters more here
/// than a response that can be parsed in every protocol detail.
pub fn health_status(address: &str) -> Result<u16, String> {
    fetch(address, "/health").map(|(status, _)| status)
}

/// Asks the local server for a path, and gives back its status and body.
pub fn fetch(address: &str, path: &str) -> Result<(u16, String), String> {
    let rest = address
        .strip_prefix("http://")
        .ok_or_else(|| format!("{address} is not an http address"))?;
    let (host, port) = match rest.split_once(':') {
        Some((host, port)) => (
            host.to_string(),
            port.trim_end_matches('/')
                .parse::<u16>()
                .map_err(|error| format!("{port} is not a port: {error}"))?,
        ),
        None => (rest.trim_end_matches('/').to_string(), 80),
    };
    let mut stream =
        TcpStream::connect((host.as_str(), port)).map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_millis(2000)))
        .map_err(|error| error.to_string())?;
    stream
        .write_all(
            format!("GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .map_err(|error| error.to_string())?;
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response);
    let text = String::from_utf8_lossy(&response).to_string();
    let status = text
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| {
            format!(
                "no status line in {}",
                text.chars().take(80).collect::<String>()
            )
        })?
        .parse::<u16>()
        .map_err(|error| format!("no status code: {error}"))?;
    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_string())
        .unwrap_or_default();
    Ok((status, body))
}

/// Waits for the interface to answer, and says what was wrong the last time it did not.
///
/// The probe is passed in so the waiting itself can be tested: the loop is the part that gets
/// written wrong (a timeout measured after the first attempt, a sleep that never happens), and it
/// does not need a server on the machine to be exercised.
pub fn wait_for_health(
    timeout: Duration,
    mut probe: impl FnMut() -> Result<u16, String>,
) -> Result<u16, Problem> {
    let started = Instant::now();
    loop {
        // The reason is recomputed on every attempt and the one from the last attempt is the one
        // reported: an early "connection refused" says very little about a stack that has since
        // got as far as answering the wrong thing.
        let reason = match probe() {
            Ok(status) if (200..300).contains(&status) => return Ok(status),
            Ok(status) => format!("/health answered {status}"),
            Err(error) => error,
        };
        if started.elapsed() >= timeout {
            return Err(Problem::with(
                "CCP-Bot started but its interface never passed the health check.".to_string(),
                reason,
            ));
        }
        std::thread::sleep(HEALTH_INTERVAL);
    }
}

/// The pieces a started local stack leaves behind, so the caller can stop them again.
///
/// `Debug` is derived for the tests: `expect_err` on a `Result` whose success type is not printable
/// does not compile, and a value nobody can print is exactly when a test needs to.
#[derive(Debug)]
pub struct Started {
    pub address: String,
    pub database_port: u16,
    /// Which port the built-in Bot listens on, when this checkout has one.
    pub bot_port: Option<u16>,
    /// Which port the computer listens on, when this checkout has one.
    pub computer_port: Option<u16>,
    pub bun: PathBuf,
    pub server: Child,
    pub worker: Child,
    /// The built-in Bot's own process, so the caller stops it with the rest.
    pub bot: Option<Child>,
    /// The computer's process, for the same reason.
    pub computer: Option<Child>,
}

/// Whether the dependencies are already installed in this checkout.
pub fn dependencies_installed(root: &Path) -> bool {
    root.join("node_modules").is_dir()
}

/// Whether the workspace links bun made still point into this folder.
///
/// Bun links the workspace packages (`@ccpbot/shared`, `@ccpbot/toolkit`, `@ccpbot/recorder-extension`)
/// into `node_modules` as absolute symlinks, so renaming or moving the checkout leaves them pointing
/// at a path that no longer exists. The first symptom is a server that dies with `Cannot find module
/// '@ccpbot/shared/…'` while the window only sees a health check that keeps refusing — measured here
/// after this checkout was renamed, and the repair is the same `bun install` that made the links.
pub fn workspace_links_land_here(root: &Path) -> bool {
    // Both sides are canonicalised: on Windows `canonicalize` answers with a `\\?\`-prefixed path,
    // so comparing it against the plain root would call every healthy link a stale one.
    let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    ["shared", "toolkit", "recorder-extension"]
        .iter()
        .all(|name| {
            let link = root.join("node_modules").join("@ccpbot").join(name);
            match std::fs::canonicalize(&link) {
                Ok(target) => target.starts_with(&root),
                Err(_) => false,
            }
        })
}

/// Whether the interface has been built already — the file the server serves.
pub fn interface_built(root: &Path) -> bool {
    root.join("app").join("dist").join("index.html").is_file()
}

/// Writes the values this mode owns into `.env`, leaving the rest of the file alone.
/// Writes the model the model screen chose into `.env`, through the one rule the container route
/// also uses (`env::model_environment`), so the two routes cannot disagree about what a choice means.
///
/// Why this is needed at all: the built-in Bot is a process on this machine, and the only place it
/// hears about a model is the environment its `--env-file=.env` names. Measured on a published
/// installer — the wizard's answer reached neither `.env` nor the credential store, and the Bot
/// exited on startup saying `OPENAI_API_KEY is not set, and no OPENAI_BASE_URL names an endpoint
/// that needs no key.` A person who had just answered the model screen was then told the Bot cannot
/// answer without a model. This is the missing half of that round trip.
///
/// Written before `write_env`, which owns only its own keys and keeps every other line: a key
/// somebody typed into this file by hand survives both writers.
pub fn remember_model(
    root: &Path,
    credential: &crate::env::ModelCredential,
    server_port: u16,
) -> Result<(), Problem> {
    // Nothing chosen touches nothing: a machine whose file already carries a key keeps it, and an
    // empty answer is not a reason to rewrite the file with eleven blank lines in it.
    if matches!(credential, crate::env::ModelCredential::None) {
        return Ok(());
    }
    let keys = crate::env::model_environment(credential, server_port);
    crate::env::write(&root.join(".env"), &keys, &BTreeMap::new())
        .map_err(|error| Problem::with("The model choice could not be saved.", format!("{error}")))
}

pub fn write_env(
    root: &Path,
    port: u16,
    bot_port: Option<u16>,
    computer_port: Option<u16>,
) -> Result<PathBuf, Problem> {
    let file = root.join(".env");
    let existing = std::fs::read_to_string(&file).unwrap_or_default();
    let mut values: Vec<(&str, String)> = vec![
        ("DATABASE_URL", database_url(port)),
        ("PORT", SERVER_PORT.to_string()),
        ("SERVER_PORT", SERVER_PORT.to_string()),
        (
            "APP_DIST_DIR",
            root.join("app").join("dist").to_string_lossy().to_string(),
        ),
        ("CCPBOT_SINGLE_USER", "true".to_string()),
        // The worker refuses to start without it, and there is only one answer here: the server this
        // machine runs. Compose points it at `http://server:3001`, the container's own name; on this
        // computer the service is reached over the loopback address the interface is served on.
        ("SERVER_INTERNAL_URL", SERVER_ADDRESS.to_string()),
        ("NODE_ENV", String::new()),
    ];
    // Which Bot this deployment has. Written before the server starts, because the server reads it
    // once at startup and decides from it whether a Bot exists at all: unset means the window offers
    // none, and a Bot the server cannot reach is worse than one it never had. A checkout without a
    // Bot writes the key empty rather than leaving the last run's address behind — the server's
    // `optionalHttpUrl` reads an empty value as absent, and a stale address would register an agent
    // that answers nothing.
    values.push((
        "MANAGED_AGENT_AG_UI_URL",
        bot_port.map(bot_address).unwrap_or_default(),
    ));
    // Where the server finds the computer a Bot's work happens on, and permission to talk to a
    // private address. Same reasoning as the Bot's address: read once at startup, so a checkout
    // without a computer writes the key empty rather than leaving the last run's address behind.
    values.push((
        "AGENT_COMPUTER_URL",
        computer_port.map(computer_address).unwrap_or_default(),
    ));
    values.push((
        "AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS",
        if computer_port.is_some() {
            "true".to_string()
        } else {
            String::new()
        },
    ));
    let text = merged_env(&existing, &values);
    std::fs::write(&file, text).map_err(|error| {
        Problem::with(
            "Could not write .env.".to_string(),
            format!("writing {} failed: {error}", file.display()),
        )
    })?;
    Ok(file)
}

/// Writes the CopilotKit connection the wizard collected into the same `.env`.
///
/// Without this the server refuses to start at all: `server/src/auth/dev-actor.ts` throws when no
/// identity provider is configured and `CCPBOT_SINGLE_USER` is not true, and it is the CopilotKit
/// connection that a desktop install uses instead of one. The keys are the ones
/// `server/src/config.ts` reads, and the service key is written under the name it accepts.
pub fn write_intelligence(
    root: &Path,
    api_url: &str,
    gateway_ws_url: &str,
    api_key: &str,
) -> Result<PathBuf, Problem> {
    let file = root.join(".env");
    let existing = std::fs::read_to_string(&file).unwrap_or_default();
    let values: Vec<(&str, String)> = vec![
        ("INTELLIGENCE_API_URL", api_url.trim().to_string()),
        (
            "INTELLIGENCE_GATEWAY_WS_URL",
            gateway_ws_url.trim().to_string(),
        ),
        ("INTELLIGENCE_API_KEY", api_key.trim().to_string()),
    ]
    .into_iter()
    .filter(|(_, value): &(&str, String)| !value.is_empty())
    .collect();
    if values.is_empty() {
        return Ok(file);
    }
    let text = merged_env(&existing, &values);
    std::fs::write(&file, text).map_err(|error| {
        Problem::with(
            "Could not write .env.".to_string(),
            format!("writing {} failed: {error}", file.display()),
        )
    })?;
    Ok(file)
}

/// What the server is started with: the secrets this deployment minted, plus the Intelligence
/// connection a local run answers for itself when there is nothing else.
///
/// In the child's environment rather than in `.env`, deliberately. That file is where the wizard
/// reads a connection back out of (`already_configured_for_root` in `main.rs`), so a placeholder key
/// written there would say this deployment is connected — to the wizard, and to the container route,
/// which starts against what the file says. An environment variable leaves the file alone, and it
/// also wins over `--env-file`: measured with bun 1.2.21, which is the runtime this starts.
fn server_environment(root: &Path, secrets: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut environment = secrets.clone();
    // Read with the desktop's own reader, so a blank value or a commented-out line is not a
    // connection here either: the wizard asks the same question of the same file.
    let configured = crate::env::already_set(
        &root.join(".env"),
        &["INTELLIGENCE_API_KEY", "CPK_INTELLIGENCE_API_KEY"],
    );
    if configured.is_empty() {
        environment.extend(
            LOCAL_INTELLIGENCE
                .iter()
                .map(|(name, value)| (name.to_string(), value.to_string())),
        );
    }
    environment
}

/// Whether this folder already holds the sources local mode runs.
///
/// `package.json` is the whole test: it is what every step afterwards reads, and a folder that has
/// it has been fetched (or cloned) already.
pub fn checkout_ready(root: &Path) -> bool {
    root.join("package.json").is_file()
}

/// Fetches the published sources into an empty folder, once.
///
/// The version comes from the same release the window's other route uses, and the fetch is the same
/// one: the tarball the release publishes, unpacked into the folder. Nothing here is local mode's
/// own idea of where sources come from — if the release moves, both routes move with it.
fn prepare_checkout(root: &Path, report: &mut impl FnMut(&str, &str)) -> Result<(), Problem> {
    prepare_checkout_with(root, report, |root| {
        let version = crate::deployment_release::resolve_version(root).map_err(|error| {
            Problem::with(
                "The CCP-Bot version to download could not be resolved.".to_string(),
                error,
            )
        })?;
        crate::deployment::fetch(root, &version).map_err(|error| {
            Problem::with(format!("CCP-Bot {version} could not be downloaded."), error)
        })
    })
}

/// The same fetch, with the download itself replaceable so a test can fail it on purpose. What the
/// test needs to prove is the message a person reads when a machine is offline, not the network.
fn prepare_checkout_with(
    root: &Path,
    report: &mut impl FnMut(&str, &str),
    download: impl FnOnce(&Path) -> Result<(), Problem>,
) -> Result<(), Problem> {
    report(
        "checkout",
        "Downloading CCP-Bot itself (once, then reused)…",
    );
    download(root)
}

/// Runs one `bun` command in the checkout and fails on a non-zero exit.
fn run_bun(bun: &Path, working: &Path, arguments: &[&str]) -> Result<(), Problem> {
    let output = quiet::command(bun)
        .args(arguments)
        .current_dir(working)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|error| {
            Problem::with(
                format!("bun {} could not run.", arguments.join(" ")),
                format!("spawning bun in {} failed: {error}", working.display()),
            )
        })?;
    if output.status.success() {
        return Ok(());
    }
    Err(Problem::with(
        format!("bun {} failed.", arguments.join(" ")),
        quiet::said(&output.stderr),
    ))
}

/// Starts the whole local stack, and only returns once the interface answers.
///
/// The order is not arbitrary: the database has to be up before the schema can be applied, the
/// schema before the server can serve anything, and the interface has to exist before the server
/// has something to serve. Each step reports itself, because a first run takes minutes and a window
/// that says nothing for minutes looks broken.
pub fn start(
    root: &Path,
    cache: &Path,
    bun: Option<PathBuf>,
    // What the model screen chose, absent when nobody answered it (a machine that already has a key
    // in the file it reads). See `remember_model`: without this the Bot starts and cannot answer.
    model: Option<&crate::env::ModelCredential>,
    mut report: impl FnMut(&str, &str),
) -> Result<Started, Problem> {
    // Nobody is handed a project folder they do not have. A machine that has never installed CCP-Bot
    // this way has an empty folder, and asking that person to "get a checkout" first is exactly the
    // prerequisite screen this mode exists to remove. So the sources are fetched once, from the same
    // published release the container route uses, and every later run finds them already there.
    if !checkout_ready(root) {
        prepare_checkout(root, &mut report)?;
    }
    if !checkout_ready(root) {
        return Err(Problem::with(
            "Local mode needs a CCP-Bot checkout.".to_string(),
            format!("{} has no package.json", root.display()),
        ));
    }
    report("runtime", "Preparing the local runtime…");
    let bun = install::ensure_bun(cache, bun)?;
    report(
        "database",
        "Preparing the local database (downloaded once, then reused)…",
    );
    ensure_postgres(root, cache)?;
    report(
        "database",
        "Preparing the database extension (downloaded once, then reused)…",
    );
    ensure_vector(root, cache)?;
    if !initialised(root) {
        report("database", "Initialising the database cluster…");
        init_cluster(root)?;
    }
    let port = database_port(root)?;
    // The Bot's port is asked for before `.env` is written, and `.env` is written before the server
    // starts: the server reads the Bot's address once, at startup, and has no second chance at it.
    let bot = bot_entry(root).map(|_| bot_port(root)).transpose()?;
    // The computer's port is asked for at the same moment and for the same reason: the server reads
    // its address once, at startup. The folder a Bot works in is found here too, because it is what
    // the computer is told before it starts.
    let computer = computer_entry(root)
        .map(|_| computer_port(root))
        .transpose()?;
    let workspace = workspace_folder(root);
    report("database", "Starting the database…");
    start_postgres(root, port)?;
    create_database(root, port)?;
    // The model's keys go in before `write_env`, which owns only its own keys and keeps every other
    // line: the model choice and the runtime's own addresses are the two halves of the same file the
    // Bot and the server read once, at startup.
    if let Some(credential) = model {
        remember_model(root, credential, SERVER_PORT)?;
    }
    write_env(root, port, bot, computer)?;
    if !dependencies_installed(root) || !workspace_links_land_here(root) {
        // The second half is not paranoia: those links are absolute, so a checkout that was renamed
        // or moved keeps a `node_modules` that looks installed and resolves nothing.
        report("dependencies", "Installing dependencies…");
        run_bun(&bun, root, &["install"])?;
    }
    if !interface_built(root) {
        report("interface", "Building the interface…");
        run_bun(&bun, root, &["run", "--filter", "app", "build"])?;
    }
    // The computer's dependencies are installed apart from the rest: it is deliberately not a
    // workspace member, so `bun install` at the root never touches it, and a checkout that has
    // never run a computer has no `node_modules` there yet.
    if computer.is_some() && !computer_dependencies_installed(root) {
        report("dependencies", "Installing the computer's dependencies…");
        run_bun(&bun, &root.join("agent-computer"), &["install"])?;
    }
    // The Bot's dependencies are installed apart from the rest for the same reason: it is not a
    // workspace member either, so `bun install` at the root never installs `@ag-ui/core`,
    // `@ag-ui/encoder` or `openai`. Without this step a fresh install starts the Bot with
    // `error: Cannot find module '@ag-ui/encoder' from <root>/agent-bot/src/index.ts` and the whole
    // start fails at that step, while a development checkout keeps working because its hoisted top
    // level happens to carry `@ag-ui/encoder` — at a version the Bot never declared.
    if bot.is_some() && !bot_dependencies_installed(root) {
        report("dependencies", "Installing the Bot's dependencies…");
        run_bun(&bun, &root.join("agent-bot"), &["install"])?;
    }
    report("schema", "Updating the database schema…");
    run_bun(&bun, &root.join("server"), &["run", "db:migrate"])?;
    let secrets = deployment_secrets(root)?;
    // The built-in Bot comes up before the server, because a Bot the server cannot reach is a Bot
    // the window offers and then fails to use: the address is read at startup, and there is nobody
    // to wait for it afterwards. A checkout without `agent-bot/` skips this and says so.
    let bot = match bot {
        Some(bot_port) => {
            report("bot", "Starting the built-in Bot…");
            let child = start_service(
                &bun,
                root,
                &bot_arguments(),
                &log_file(root, "bot"),
                &bot_environment(bot_port, &secrets),
            )?;
            let address = bot_address(bot_port);
            let status =
                wait_for_health(BOT_TIMEOUT, || health_status(&address)).map_err(|problem| {
                    let last = problem.detail.unwrap_or_default();
                    Problem::with(
                        "The built-in Bot did not answer.".to_string(),
                        format!("{address} never answered /health. Last time: {last}"),
                    )
                })?;
            report(
                "bot",
                &format!("The built-in Bot is answering (/health {status})."),
            );
            Some((bot_port, child))
        }
        None => {
            report(
                "bot",
                "This checkout has no built-in Bot (agent-bot/src/index.ts is missing).",
            );
            None
        }
    };
    // The computer is what lets a Bot touch files rather than only talk: the server's file and
    // command tools all go through it. It starts before the server, for the same reason the Bot
    // does — the server reads its address at startup — and it is told which folder of this
    // computer a Bot may work in. That folder is the whole point of this mode, so it is created
    // here if it does not exist yet, and everything a Bot does inside it is confined to it by
    // `agent-computer/src/workspace.ts`.
    let computer = match computer {
        Some(computer_port) => {
            std::fs::create_dir_all(&workspace).map_err(|error| {
                Problem::with(
                    "Local mode could not open the folder a Bot works in.".to_string(),
                    format!("creating {} failed: {error}", workspace.display()),
                )
            })?;
            report("computer", "Starting the computer your Bot works in…");
            let child = start_service(
                &bun,
                root,
                &[COMPUTER_ENTRY.to_string()],
                &log_file(root, "computer"),
                &computer_environment(root, computer_port, &secrets, &workspace),
            )?;
            let address = computer_address(computer_port);
            let status = wait_for_health(COMPUTER_TIMEOUT, || health_status(&address)).map_err(
                |problem| {
                    let last = problem.detail.unwrap_or_default();
                    Problem::with(
                        "The computer did not answer.".to_string(),
                        format!("{address} never answered /health. Last time: {last}"),
                    )
                },
            )?;
            report(
                "computer",
                &format!("Bots work in {} (/health {status}).", workspace.display()),
            );
            Some((computer_port, child))
        }
        None => {
            report(
                "computer",
                "This checkout has no computer (agent-computer/src/index.ts is missing).",
            );
            None
        }
    };
    report("server", "Starting the services…");
    // Both services run from `server/`, the way the container runs them. The server's default tenant
    // package is `../examples/fintech`, which only resolves from there — started from the root it
    // dies on `ENOENT` opening `..\examples\fintech\brand.yaml` — and the worker is started as
    // `../worker/src/index.ts` from the same place, exactly as compose does it.
    let services = root.join("server");
    let server = start_service(
        &bun,
        &services,
        &service_arguments("../.env", "src/index.ts"),
        &log_file(root, "server"),
        &server_environment(root, &secrets),
    )?;
    // The worker is handed its three settings and nothing else, as compose hands them: it does not
    // read the deployment's configuration, and the less this process holds the less a mistake in it
    // can spend.
    let worker_environment: BTreeMap<String, String> = [
        ("DATABASE_URL", database_url(port)),
        ("SERVER_INTERNAL_URL", SERVER_ADDRESS.to_string()),
        (
            "WORKER_SHARED_SECRET",
            secrets
                .get("WORKER_SHARED_SECRET")
                .cloned()
                .unwrap_or_default(),
        ),
    ]
    .into_iter()
    .map(|(name, value)| (name.to_string(), value))
    .collect();
    let worker = start_service(
        &bun,
        &services,
        &["../worker/src/index.ts".to_string()],
        &log_file(root, "worker"),
        &worker_environment,
    )?;
    let address = SERVER_ADDRESS.to_string();
    let status = wait_for_health(HEALTH_TIMEOUT, || health_status(&address))?;
    report(
        "ready",
        &format!("CCP-Bot is running on this computer (/health {status})."),
    );
    let (bot_port, bot) = match bot {
        Some((port, child)) => (Some(port), Some(child)),
        None => (None, None),
    };
    let (computer_port, computer) = match computer {
        Some((port, child)) => (Some(port), Some(child)),
        None => (None, None),
    };
    Ok(Started {
        address,
        database_port: port,
        bot_port,
        computer_port,
        bun,
        server,
        worker,
        bot,
        computer,
    })
}

/// Ends one service and everything it started.
///
/// The tree matters: `bun` starts the server in the same process, but a worker may spawn children,
/// and on Windows a killed parent leaves its children running — which is how a port stays taken
/// after the window is gone.
pub fn end(child: &mut Child) {
    #[cfg(windows)]
    {
        let pid = child.id().to_string();
        let _ = quiet::command("taskkill")
            .args(["/PID", pid.as_str(), "/T", "/F"])
            .output();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Stops the whole local stack: the services, then the database.
pub fn stop(root: &Path, children: &mut Vec<Child>) -> Result<(), Problem> {
    for mut child in children.drain(..) {
        end(&mut child);
    }
    stop_postgres(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("ccpbot-local-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("a scratch folder");
        path
    }

    /// One POST with the token the service was started with, for the endpoints the server calls.
    ///
    /// The client above only speaks GET, which is all the health checks need; the endpoints that ask
    /// the computer to do something are all POSTs, so this is what asks them.
    fn post(address: &str, path: &str, token: &str, body: &str) -> Result<(u16, String), Problem> {
        use std::io::{Read as _, Write as _};

        let host = address.trim_start_matches("http://");
        let mut stream = std::net::TcpStream::connect(host).map_err(|error| {
            Problem::with("The computer could not be reached.", error.to_string())
        })?;
        stream.set_read_timeout(Some(Duration::from_secs(20))).ok();
        let request = format!(
            "POST {path} HTTP/1.1\r\nHost: {host}\r\nx-ccpbot-computer-token: {token}\r\n\
             content-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        stream
            .write_all(request.as_bytes())
            .map_err(|error| Problem::with("The request could not be sent.", error.to_string()))?;
        let mut answer = String::new();
        stream
            .read_to_string(&mut answer)
            .map_err(|error| Problem::with("No answer came back.", error.to_string()))?;
        let status = answer
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse().ok())
            .unwrap_or(0);
        let body = answer
            .split_once("\r\n\r\n")
            .map(|(_, body)| body.to_string())
            .unwrap_or_default();
        Ok((status, body))
    }

    /// Everything this mode creates belongs under the root the person chose, so that deleting that
    /// folder is a complete uninstall.
    #[test]
    fn layout_keeps_everything_under_the_root() {
        let root = PathBuf::from("C:/somewhere/CCP-Bot");
        for path in [
            postgres_folder(&root),
            bin_folder(&root),
            data_folder(&root),
            logs_folder(&root),
            log_file(&root, "server"),
            tool(&root, "postgres"),
        ] {
            assert!(
                path.starts_with(&root),
                "{} escaped {}",
                path.display(),
                root.display()
            );
        }
        assert!(tool(&root, "postgres").to_string_lossy().contains("pgsql"));
        assert!(log_file(&root, "server")
            .to_string_lossy()
            .ends_with(".log"));
    }

    /// The port is written down the first time and read back after that, because the same value
    /// also lands in `DATABASE_URL` — a port that moved every start would rewrite that line and
    /// strand anything that connected a moment earlier.
    #[test]
    fn the_port_is_asked_for_once_and_remembered() {
        let root = scratch("port-once");
        let first = database_port(&root).expect("a port");
        assert!(first > 0);
        assert_eq!(database_port(&root).expect("the same port"), first);
        assert_eq!(
            std::fs::read_to_string(port_file(&root))
                .expect("the port file")
                .trim(),
            first.to_string()
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `PG_VERSION` is what `initdb` leaves behind, and it is what decides whether a cluster has to
    /// be created at all.
    #[test]
    fn an_initialised_cluster_is_recognised() {
        let root = scratch("initialised");
        assert!(!initialised(&root));
        std::fs::create_dir_all(data_folder(&root)).expect("the data folder");
        std::fs::write(data_folder(&root).join("PG_VERSION"), "17\n").expect("the marker");
        assert!(initialised(&root));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Our keys are replaced where they already are: the file belongs to the person, and a second
    /// `DATABASE_URL` further down would win or lose depending on who read it last.
    #[test]
    fn merging_env_replaces_the_keys_it_owns() {
        let existing = "DATABASE_URL=postgres://old\nPORT=9999\nOTHER=kept\n";
        let merged = merged_env(
            existing,
            &[
                ("DATABASE_URL", database_url(5433)),
                ("PORT", SERVER_PORT.to_string()),
            ],
        );
        assert!(merged.contains(&format!(
            "DATABASE_URL=postgres://ccpbot@127.0.0.1:5433/ccpbot"
        )));
        assert!(merged.contains("PORT=3010"));
        assert!(!merged.contains("9999"));
        assert_eq!(merged.matches("DATABASE_URL=").count(), 1);
    }

    /// Comments and settings that are none of our business survive untouched — the same file
    /// carries the person's own provider keys.
    #[test]
    fn merging_env_keeps_comments_and_other_keys() {
        let existing = "# my notes\nOPENAI_API_KEY=sk-secret\nCCPBOT_SINGLE_USER=false\n";
        let merged = merged_env(existing, &[("CCPBOT_SINGLE_USER", "true".to_string())]);
        assert!(merged.contains("# my notes"));
        assert!(merged.contains("OPENAI_API_KEY=sk-secret"));
        assert!(merged.contains("CCPBOT_SINGLE_USER=true"));
        assert!(!merged.contains("CCPBOT_SINGLE_USER=false"));
        assert!(merged.contains("# my notes"));
    }

    /// A key the file has never seen is appended, under a line that says who put it there.
    #[test]
    fn merging_env_appends_a_key_it_has_never_seen() {
        let merged = merged_env(
            "OPENAI_API_KEY=sk-secret\n",
            &[("APP_DIST_DIR", "/app/dist".to_string())],
        );
        assert!(merged.contains("# Written by CCP-Bot local mode."));
        assert!(merged.contains("APP_DIST_DIR=/app/dist"));
        assert!(merged.trim_end().ends_with("APP_DIST_DIR=/app/dist"));
    }

    /// What the wizard collected has to reach the server, and the file is shared with whatever else
    /// the person put in it.
    #[test]
    fn the_copilotkit_connection_is_written_beside_the_rest_of_the_file() {
        let root = scratch("intelligence");
        std::fs::write(root.join(".env"), "# mine\nOPENAI_API_KEY=sk-secret\n").expect("a .env");
        write_intelligence(
            &root,
            "https://api.example",
            "wss://api.example/gateway",
            "sk-service",
        )
        .expect("writing the connection");
        let written = std::fs::read_to_string(root.join(".env")).expect("the .env");
        assert!(written.contains("INTELLIGENCE_API_URL=https://api.example"));
        assert!(written.contains("INTELLIGENCE_API_KEY=sk-service"));
        assert!(written.contains("# mine"));
        assert!(written.contains("OPENAI_API_KEY=sk-secret"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// An empty answer is not a value: a wizard that skipped a field must not write a blank key over
    /// one that was already there.
    #[test]
    fn an_empty_connection_leaves_the_file_as_it_was() {
        let root = scratch("intelligence-empty");
        std::fs::write(
            root.join(".env"),
            "INTELLIGENCE_API_URL=https://kept.example\n",
        )
        .expect("a .env");
        write_intelligence(&root, "", "", "").expect("nothing to write");
        let written = std::fs::read_to_string(root.join(".env")).expect("the .env");
        assert_eq!(written, "INTELLIGENCE_API_URL=https://kept.example\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Somebody who answers nothing but the model screen still gets a stack that starts: with no
    /// connection anywhere, the server is handed the three values it insists on.
    #[test]
    fn a_run_with_no_connection_of_its_own_answers_for_one() {
        let root = scratch("intelligence-stand-in");
        write_env(&root, 63133, Some(4211), Some(6210)).expect("writing .env");
        let environment = server_environment(&root, &BTreeMap::new());
        assert_eq!(environment.len(), LOCAL_INTELLIGENCE.len());
        for (name, value) in LOCAL_INTELLIGENCE {
            assert_eq!(environment.get(name).map(String::as_str), Some(value));
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A connection that is already there is never replaced by the stand-in, under either of the two
    /// names the server reads a key from — and a commented-out line is not a connection.
    #[test]
    fn a_connection_in_the_file_is_left_alone() {
        let root = scratch("intelligence-kept");
        std::fs::write(
            root.join(".env"),
            "CPK_INTELLIGENCE_API_KEY=sk-mine\n# INTELLIGENCE_API_KEY=sk-commented-out\n",
        )
        .expect("a .env");
        let secrets = BTreeMap::from([("WORKER_SHARED_SECRET".to_string(), "worker".to_string())]);
        let environment = server_environment(&root, &secrets);
        assert_eq!(environment.len(), 1);
        assert_eq!(
            environment.get("WORKER_SHARED_SECRET").map(String::as_str),
            Some("worker")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The whole point of unpacking once: a machine that already has the database never touches the
    /// network again. The fetch here fails loudly if it is called at all.
    #[test]
    fn a_failure_is_read_from_the_last_lines_of_the_log() {
        let root = scratch("tail");
        std::fs::create_dir_all(logs_folder(&root)).expect("the logs folder");
        let log = log_file(&root, "postgres");
        std::fs::write(&log, "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n").expect("a log");
        let tail = tail_of(&log);
        assert!(tail.contains("eight"), "{tail}");
        assert!(tail.contains("three"), "{tail}");
        assert!(!tail.contains("one"), "{tail}");
        assert!(!tail.contains("two"), "{tail}");

        let missing = tail_of(&root.join("nowhere.log"));
        assert!(missing.contains("nothing to read"), "{missing}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The extension is fetched once and placed once; a server that already has it is left alone.
    #[test]
    fn the_deployment_mints_its_secrets_and_reuses_them() {
        let root = scratch("secrets");
        let first = deployment_secrets(&root).expect("minting the deployment secrets");
        assert_eq!(first.len(), crate::env::MINTED.len());
        for key in crate::env::MINTED {
            let value = first.get(key).expect("every secret the deployment needs");
            assert!(!value.trim().is_empty(), "{key} was minted blank");
        }
        // Measured the hard way: `KEY_ENCRYPTION_KEY` decrypts everything the server stores, so a
        // restart that minted a new one would leave the vault of the run before it unreadable.
        let second = deployment_secrets(&root).expect("reading them back");
        assert_eq!(first, second, "a restart minted new secrets");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The extension is fetched once and placed once; a server that already has it is left alone.
    #[test]
    fn an_installed_extension_is_not_fetched_again() {
        let root = scratch("vector");
        std::fs::create_dir_all(extension_folder(&root)).expect("the extension folder");
        std::fs::write(
            extension_folder(&root).join(VECTOR_CONTROL),
            "comment = 'x'",
        )
        .expect("a control file");
        assert!(vector_installed(&root));
        let done = ensure_vector_with(
            &root,
            &root,
            |_: &Download, _: &Path| -> Result<PathBuf, Problem> {
                panic!("a server that already has the extension must not download it again")
            },
        )
        .expect("nothing to do");
        assert!(!done);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The library and the control file are the two things the server needs; the headers beside them
    /// in the archive are not, and copying them into the server would be pretending otherwise.
    #[test]
    fn placing_the_extension_puts_the_library_and_the_control_file_where_the_server_looks() {
        let root = scratch("placing");
        let staging = postgres_folder(&root).join(VECTOR_FOLDER);
        std::fs::create_dir_all(staging.join("lib")).expect("the staging library");
        std::fs::create_dir_all(staging.join("share").join("extension"))
            .expect("the staging scripts");
        std::fs::create_dir_all(staging.join("include").join("server"))
            .expect("the staging headers");
        std::fs::write(staging.join("lib").join("vector.dll"), "dll").expect("a library");
        std::fs::write(
            staging.join("share").join("extension").join(VECTOR_CONTROL),
            "comment = 'x'",
        )
        .expect("a control file");
        std::fs::write(
            staging
                .join("share")
                .join("extension")
                .join("vector--0.8.6.sql"),
            "-- vector",
        )
        .expect("a script");
        std::fs::write(staging.join("include").join("server").join("vector.h"), "h")
            .expect("a header");

        place_vector(&root, &staging).expect("placing the extension");
        assert!(lib_folder(&root).join("vector.dll").is_file());
        assert!(vector_installed(&root));
        let scripts = extension_folder(&root);
        assert!(scripts.join("vector--0.8.6.sql").is_file());
        assert!(!unpacked_folder(&root).join("include").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The whole point of unpacking once: a machine that already has the database never touches the
    /// network again. The fetch here fails loudly if it is called at all.
    #[test]
    fn an_unpacked_database_is_not_fetched_again() {
        let root = scratch("no-refetch");
        std::fs::create_dir_all(bin_folder(&root)).expect("the bin folder");
        std::fs::write(tool(&root, "postgres"), b"binary").expect("postgres");
        std::fs::write(tool(&root, "initdb"), b"binary").expect("initdb");
        let result = ensure_postgres_with(&root, &root, |_, _| {
            panic!("an unpacked database must not be downloaded again")
        });
        assert!(result.is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// When the download is refused, the reason has to reach the window: "it failed" leaves somebody
    /// with nothing to do, and the usual reason here is a network that cannot reach the host.
    #[test]
    fn a_refused_download_says_why() {
        let root = scratch("refused");
        let error = ensure_postgres_with(&root, &root, |_, _| {
            Err(Problem::with(
                "Downloading the portable database failed.".to_string(),
                "connection reset by peer".to_string(),
            ))
        })
        .expect_err("a refused download is an error");
        assert!(
            error.said.contains("portable database failed"),
            "{}",
            error.said
        );
        let detail = error.detail.unwrap_or_default();
        assert!(detail.contains("connection reset"), "{detail}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Waiting ends on the first healthy answer rather than after the whole timeout, which is what
    /// makes a warm start feel fast.
    #[test]
    fn waiting_ends_when_health_answers() {
        let mut attempts = 0;
        let status = wait_for_health(Duration::from_secs(5), || {
            attempts += 1;
            if attempts < 3 {
                Err("connection refused".to_string())
            } else {
                Ok(200)
            }
        })
        .expect("a healthy stack");
        assert_eq!(status, 200);
        assert_eq!(attempts, 3);
    }

    /// A stack that never answers reports the last thing that went wrong, not just that time ran
    /// out: the last reason is the one that describes what is broken.
    #[test]
    fn a_stack_that_never_answers_reports_the_last_reason() {
        let error = wait_for_health(Duration::from_millis(50), || {
            Err("connection refused".to_string())
        })
        .expect_err("a stack that never answers");
        let detail = error.detail.unwrap_or_default();
        assert!(detail.contains("connection refused"), "{detail}");
    }

    /// A folder that already holds the sources is one local mode runs; an empty one is not — and the
    /// difference is a single file, which is why the check is not a directory listing.
    #[test]
    fn a_folder_with_package_json_is_a_checkout() {
        let root = scratch("is-checkout");
        assert!(!checkout_ready(&root), "an empty folder is not a checkout");
        std::fs::write(root.join("package.json"), "{}").expect("a package.json");
        assert!(
            checkout_ready(&root),
            "a folder with the manifest is a checkout"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A machine that has never installed CCP-Bot this way has an empty folder, so the first run
    /// fetches the sources — and when that fetch fails, the person is told what failed rather than
    /// being sent to find a checkout of their own.
    #[test]
    fn an_empty_folder_is_filled_from_the_release_and_told_when_that_fails() {
        let root = scratch("fetch-checkout");
        let mut steps: Vec<String> = Vec::new();
        let error = prepare_checkout_with(
            &root,
            &mut |step: &str, _| steps.push(step.to_string()),
            |_| {
                Err(Problem::with(
                    "CCP-Bot v0.0.0 could not be downloaded.".to_string(),
                    "offline".to_string(),
                ))
            },
        )
        .expect_err("no download, no checkout");
        assert_eq!(steps, vec!["checkout".to_string()]);
        assert!(
            error.said.contains("could not be downloaded"),
            "{}",
            error.said
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// One file holds the settings for every service, so there is one place to look when something
    /// reads the wrong database.
    #[test]
    fn every_service_is_started_with_one_env_file() {
        // The file is named relative to `server/`, because that is where the services run from: the
        // server's default tenant package is `../examples/fintech`, and started from the root it dies
        // on `ENOENT` opening `..\examples\fintech\brand.yaml`.
        assert_eq!(
            service_arguments("../.env", "src/index.ts"),
            vec!["--env-file=../.env".to_string(), "src/index.ts".to_string()]
        );
    }

    /// The database is reachable from this machine and no other.
    #[test]
    fn the_connection_string_is_loopback_only() {
        let url = database_url(5433);
        assert_eq!(url, "postgres://ccpbot@127.0.0.1:5433/ccpbot");
        assert!(!url.contains("0.0.0.0"));
    }

    /// The Bot is started from the root, and told which port to listen on.
    ///
    /// From the root because its entry file imports `../../shared/...`, which only resolves when the
    /// process starts where the repository is; and with `.env` because that is where the wizard's
    /// model key landed, for the server and the Bot alike.
    #[test]
    fn the_bot_runs_from_the_checkout_root_with_the_settings_file() {
        assert_eq!(
            bot_arguments(),
            vec!["--env-file=.env".to_string(), BOT_ENTRY.to_string()]
        );
        let secrets: BTreeMap<String, String> = [(
            "MANAGED_AGENT_TOKEN".to_string(),
            "synthetic-token".to_string(),
        )]
        .into_iter()
        .collect();
        let environment = bot_environment(4211, &secrets);
        assert_eq!(environment.get("PORT").map(String::as_str), Some("4211"));
        assert_eq!(
            environment.get("MANAGED_AGENT_TOKEN").map(String::as_str),
            Some("synthetic-token")
        );
        assert_eq!(
            environment.len(),
            2,
            "the Bot is handed its port and its token, and reads the rest from .env"
        );
    }

    /// The server is pointed at the Bot and the computer through `.env`, or it has neither.
    #[test]
    fn the_server_is_told_where_the_bot_is() {
        let root = scratch("bot-env");
        std::fs::create_dir_all(&root).expect("scratch root");
        let file = write_env(&root, 63133, Some(4211), Some(6210)).expect("writing .env");
        let text = std::fs::read_to_string(&file).expect("reading .env");
        assert!(
            text.contains("MANAGED_AGENT_AG_UI_URL=http://127.0.0.1:4211"),
            "{text}"
        );
        assert!(
            text.contains("AGENT_COMPUTER_URL=http://127.0.0.1:6210"),
            "{text}"
        );
        // The server refuses a private computer address unless this says otherwise, and a Bot's
        // computer is always on the loopback address.
        assert!(
            text.contains("AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true"),
            "{text}"
        );
        // A checkout with no Bot or no computer must not leave a stale address behind: the server
        // would register an agent, or reach for a computer, that answers nothing. Both keys stay,
        // empty, which the server reads as absent.
        let file = write_env(&root, 63133, None, None).expect("writing .env again");
        let text = std::fs::read_to_string(&file).expect("reading .env");
        assert!(!text.contains("MANAGED_AGENT_AG_UI_URL=http://"), "{text}");
        assert!(!text.contains("AGENT_COMPUTER_URL=http://"), "{text}");
        assert!(
            !text.contains("AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true"),
            "{text}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The Bot's port is asked for once, so a restart finds the Bot where `.env` says it is.
    #[test]
    fn the_bot_port_is_asked_for_once_and_remembered() {
        let root = scratch("bot-port");
        assert_eq!(remembered_bot_port(&root), None);
        let chosen = bot_port(&root).expect("a free port");
        assert!(chosen > 0);
        assert_eq!(remembered_bot_port(&root), Some(chosen));
        assert_eq!(bot_port(&root).ok(), Some(chosen));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A checkout without the Bot says so instead of failing the whole start.
    #[test]
    fn a_checkout_without_a_bot_has_none_to_start() {
        let root = scratch("no-bot");
        std::fs::create_dir_all(root.join("agent-bot").join("src")).expect("agent-bot folder");
        assert_eq!(
            bot_entry(&root),
            None,
            "a folder without an entry is not a Bot"
        );
        std::fs::write(root.join(BOT_ENTRY), "// the Bot\n").expect("the entry file");
        assert_eq!(bot_entry(&root), Some(root.join(BOT_ENTRY)));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The Bot's dependencies are its own install, not the root one: a fresh install runs the root
    /// `bun install` and still has nothing `agent-bot/src/index.ts` can resolve, which is exactly the
    /// failure this guard is here to prevent.
    #[test]
    fn the_bots_dependencies_are_its_own_install() {
        let root = scratch("bot-deps");
        assert!(
            !bot_dependencies_installed(&root),
            "nothing is installed yet"
        );
        std::fs::create_dir_all(root.join("node_modules")).expect("the root install");
        assert!(
            !bot_dependencies_installed(&root),
            "the root install is not the Bot's install"
        );
        std::fs::create_dir_all(root.join("agent-bot").join("node_modules"))
            .expect("the Bot's install");
        assert!(bot_dependencies_installed(&root));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The choice survives a restart without any settings file, which is what makes the Windows stage
    /// skip itself on the second start of the same folder.
    #[test]
    fn remembering_local_mode_survives_for_the_next_start() {
        let root = scratch("marker");
        assert!(!wanted(&root));
        remember(&root).expect("remembering");
        assert!(wanted(&root));
        assert_eq!(marker(&root).file_name().unwrap(), MARKER_FILE);
        forget(&root).expect("forgetting");
        assert!(!wanted(&root));
        // Forgetting something that was never there is the outcome that was wanted, not an error.
        forget(&root).expect("forgetting twice");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A window that has never been set up has no root yet, and "run this folder locally" is the click
    /// that brings it into being: writing the marker must make the folder rather than fail on it.
    #[test]
    fn remembering_a_folder_that_is_not_there_yet_makes_it() {
        let parent = scratch("marker-makes");
        let root = parent.join("nested").join("ccpbot");
        assert!(!root.exists());
        remember(&root).expect("remembering into a folder that does not exist yet");
        assert!(wanted(&root));
        let _ = std::fs::remove_dir_all(&parent);
    }

    /// A path that is not there is a status, not a hang: the shell asks before anything is up.
    #[test]
    fn fetching_a_missing_path_answers_rather_than_hanging() {
        let closed = free_port().expect("a closed port");
        let error = fetch(&format!("http://127.0.0.1:{closed}"), "/health")
            .expect_err("nothing is listening");
        assert!(!error.is_empty(), "the reason has to say something");
        assert!(fetch("not-an-address", "/health").is_err());
    }

    /// The evidence this mode exists for: on this machine, as a standard account, with no container
    /// engine anywhere in the picture, the database, the server and the worker come up and the
    /// interface answers on its own address.
    ///
    /// Ignored by default because it is minutes on a first run — it fetches the runtime and the
    /// portable database, unpacks 1.5 GB of PostgreSQL, builds the interface and starts real
    /// processes — and because it writes `postgres/`, `logs/` and `.env` under the checkout.
    /// The model screen's answer has to reach the file the Bot is told to read it from. Measured on a
    /// published installer, it reached nothing: the Bot exited saying `OPENAI_API_KEY is not set, and
    /// no OPENAI_BASE_URL names an endpoint that needs no key.` after a person had just answered that
    /// screen.
    #[test]
    fn a_model_choice_reaches_the_file_the_bot_reads() {
        let tmp = std::env::temp_dir().join(format!("ccpbot-local-model-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).expect("a scratch folder");
        let file = tmp.join(".env");
        std::fs::write(&file, "SOMETHING_MINE=1\nOPENAI_API_KEY=\n")
            .expect("a file with a line of mine");

        remember_model(
            &tmp,
            &crate::env::ModelCredential::OpenAi {
                api_key: "sk-from-the-model-screen".to_string(),
            },
            SERVER_PORT,
        )
        .expect("the model choice is written");

        let written = std::fs::read_to_string(&file).expect("the file is readable");
        assert!(
            written.contains("OPENAI_API_KEY=sk-from-the-model-screen"),
            "{written}"
        );
        // Every other model key is emptied, so a plan answered in an earlier run cannot be preferred
        // over the key somebody just gave: whichever key a Bot reads first decides who is billed.
        assert!(written.contains("ANTHROPIC_API_KEY="), "{written}");
        assert!(!written.contains("ANTHROPIC_API_KEY=sk"), "{written}");
        // And a line this writer does not own survives it, which is what lets a hand-written key stay.
        assert!(written.contains("SOMETHING_MINE=1"), "{written}");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Nothing answered means nothing touched: a machine whose file already carries a key keeps it.
    #[test]
    fn nothing_chosen_leaves_the_file_alone() {
        let tmp = std::env::temp_dir().join(format!("ccpbot-local-nomodel-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).expect("a scratch folder");
        let file = tmp.join(".env");
        std::fs::write(&file, "OPENAI_API_KEY=typed-by-hand\n").expect("a file somebody wrote");

        remember_model(&tmp, &crate::env::ModelCredential::None, SERVER_PORT)
            .expect("no choice is not an error");

        assert_eq!(
            std::fs::read_to_string(&file).expect("the file is readable"),
            "OPENAI_API_KEY=typed-by-hand\n"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }
    #[test]
    #[ignore = "downloads the runtime, unpacks the portable database and starts real processes"]
    fn live_start_serves_the_interface_on_this_machine() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|path| path.parent())
            .expect("the checkout above src-tauri")
            .to_path_buf();
        let cache = std::env::temp_dir().join("ccpbot-local-cache");
        let mut steps: Vec<String> = Vec::new();
        // No intelligence connection is written, and that is the point of this test: somebody who
        // installs this and answers nothing but the model screen gets a stack that starts. What
        // stands in for the connection is `LOCAL_INTELLIGENCE`, handed to the server by
        // `server_environment`, and writing it here would hide whether that works. The assertion
        // below is what keeps the claim honest on a machine that has a connection of its own.
        assert!(
            server_environment(&root, &BTreeMap::new()).contains_key("INTELLIGENCE_API_KEY"),
            "{} already holds an Intelligence connection, so a start on this machine does not show \
             that one is not needed",
            root.join(".env").display()
        );
        // And the model key, which an earlier step of the wizard puts in the same file through this
        // same writer. The built-in Bot holds a model credential and exits with
        // `OPENAI_API_KEY is not set, and no OPENAI_BASE_URL names an endpoint that needs no key`
        // without one — measured on this machine, not assumed — so the test supplies the placeholder
        // that a person's own key replaces.
        // Through the same path the window uses, rather than a key written here by hand: a local run
        // is handed the model screen's answer, and the key it implies has to land in the file the Bot
        // is told to read. This placeholder is what makes a local run startable without a person's own
        // key, and it is the exact shape the wizard sends.
        let credential = crate::env::ModelCredential::OpenAi {
            api_key: "sk-local-placeholder-for-a-desktop-run".to_string(),
        };
        let started = start(&root, &cache, None, Some(&credential), |step, detail| {
            println!("[{step}] {detail}");
            steps.push(step.to_string());
        })
        .expect("the local stack should start");

        let file = std::fs::read_to_string(root.join(".env")).expect("the file is readable");
        assert!(
            file.contains("OPENAI_API_KEY=sk-local-placeholder-for-a-desktop-run"),
            "{file}"
        );
        let status = health_status(&started.address).expect("the interface answers");
        assert_eq!(status, 200, "the address is {}", started.address);
        let (page, body) = fetch(&started.address, "/").expect("the interface is served");
        assert_eq!(page, 200);
        assert!(
            body.to_lowercase().contains("<div id=\"root\"") || body.contains("CCP-Bot"),
            "the page served is not the interface: {}",
            body.chars().take(200).collect::<String>()
        );
        assert!(
            steps.iter().any(|step| step == "ready"),
            "the run reported {steps:?}"
        );
        // The built-in Bot is the difference between an install that shows a Bot and one that can
        // run it, so the test asks it directly rather than trusting the server to have found it.
        let bot_port = started
            .bot_port
            .expect("this checkout ships a built-in Bot");
        let bot = bot_address(bot_port);
        let bot_status = health_status(&bot).expect("the Bot answers");
        assert_eq!(bot_status, 200, "the Bot is at {bot}");
        println!(
            "local stack up on {} with database port {} and the Bot on {bot}",
            started.address, started.database_port
        );

        // Talking is not working. The computer is what turns "write me a script" into a file on this
        // disk, so the test asks it to write one and then to run something in the same folder — with
        // the token this deployment minted, exactly as the server does it for a Bot.
        let computer_port = started
            .computer_port
            .expect("this checkout ships a computer");
        let computer = computer_address(computer_port);
        let computer_status = health_status(&computer).expect("the computer answers");
        assert_eq!(computer_status, 200, "the computer is at {computer}");
        let secrets =
            crate::vault::already_given_no_ui(&root, &root.join(".env"), &crate::env::MINTED)
                .expect("the secrets this deployment minted");
        let token = secrets
            .get("COMPUTER_TOKEN")
            .expect("a token for the computer")
            .clone();
        let workspace = workspace_folder(&root);
        let (written, answer) = post(
            &computer,
            "/files/write",
            &token,
            r#"{"path":"ccpbot-hands-check.txt","contents":"written by the computer"}"#,
        )
        .expect("the computer is asked to write a file");
        assert_eq!(written, 200, "writing said: {answer}");
        let marker = workspace.join("ccpbot-hands-check.txt");
        assert!(
            marker.is_file(),
            "the file did not land in {}: {answer}",
            workspace.display()
        );
        assert_eq!(
            std::fs::read_to_string(&marker).expect("the file it wrote"),
            "written by the computer"
        );
        let (ran, output) = post(
            &computer,
            "/exec",
            &token,
            r#"{"command":"echo ccpbot-hands"}"#,
        )
        .expect("the computer is asked to run a command");
        assert_eq!(ran, 200, "running said: {output}");
        assert!(
            output.contains("ccpbot-hands"),
            "the command answered: {output}"
        );
        println!(
            "the computer wrote {} and ran a command in it",
            marker.display()
        );
        let _ = std::fs::remove_file(&marker);

        let mut children = vec![started.server, started.worker];
        if let Some(bot) = started.bot {
            children.push(bot);
        }
        if let Some(computer) = started.computer {
            children.push(computer);
        }
        stop(&root, &mut children).expect("stopping the local stack");
    }

    /// The first run of a machine that has never installed CCP-Bot this way: an empty folder, and
    /// the sources arrive from the published release. This is the difference between "install and
    /// use" and "install, then go and find a checkout", so it is measured against the real release
    /// rather than a stub.
    #[test]
    #[ignore = "downloads the published release from GitHub"]
    fn live_an_empty_folder_is_filled_from_the_release() {
        let root = std::env::temp_dir().join("ccpbot-local-empty-checkout");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("an empty folder");
        assert!(!checkout_ready(&root), "the folder starts empty");

        prepare_checkout(&root, &mut |step, detail| println!("[{step}] {detail}"))
            .expect("the sources should arrive");

        assert!(checkout_ready(&root), "the manifest arrived");
        assert!(root.join("server").is_dir(), "the server sources arrived");
        assert!(
            root.join(BOT_ENTRY).is_file(),
            "the built-in Bot arrived with the rest"
        );
        println!(
            "downloaded {} into {}",
            std::fs::read_to_string(root.join("package.json"))
                .expect("the manifest")
                .lines()
                .find(|line| line.contains("\"version\""))
                .unwrap_or("version unknown")
                .trim(),
            root.display()
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// What a machine that has never installed CCP-Bot this way does: an empty folder, the sources
    /// from the published release, and the Bot's own dependencies installed into it before the Bot is
    /// started. That last step is the one a development checkout hides — its hoisted top level
    /// carries an `@ag-ui/encoder` the Bot never declared — so a fresh checkout is the only place the
    /// missing step shows, and building one is what this test is for.
    #[test]
    #[ignore = "downloads the published release and starts real processes"]
    fn live_a_fresh_folder_installs_the_bots_own_dependencies() {
        let root = std::env::temp_dir().join("ccpbot-local-fresh-install");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("an empty folder");
        assert!(!checkout_ready(&root), "the folder starts empty");

        let cache = std::env::temp_dir().join("ccpbot-local-cache");
        prepare_checkout(&root, &mut |step, detail| println!("[{step}] {detail}"))
            .expect("the sources should arrive");
        assert!(checkout_ready(&root), "the manifest arrived");
        assert!(
            bot_entry(&root).is_some(),
            "the built-in Bot arrived with the rest"
        );
        assert!(
            !bot_dependencies_installed(&root),
            "the release carries the Bot's sources, not its dependencies"
        );

        // The model key, the one thing this mode does not guess: without it the Bot exits saying so
        // rather than answering, which looks like a Bot that never comes up.
        let model: BTreeMap<String, String> = [(
            "OPENAI_API_KEY".to_string(),
            "sk-local-placeholder-for-a-desktop-run".to_string(),
        )]
        .into_iter()
        .collect();
        crate::env::write(&root.join(".env"), &model, &BTreeMap::new())
            .expect("the model key is written");

        let mut steps: Vec<(String, String)> = Vec::new();
        let started = start(&root, &cache, None, None, |step, detail| {
            println!("[{step}] {detail}");
            steps.push((step.to_string(), detail.to_string()));
        })
        .expect("the local stack should start");

        assert!(
            bot_dependencies_installed(&root),
            "the Bot's own dependencies should be installed into {}",
            root.display()
        );
        let installed = steps
            .iter()
            .find(|(step, detail)| {
                step == "dependencies" && detail.contains("Installing the Bot's dependencies")
            })
            .unwrap_or_else(|| panic!("the run never installed the Bot's dependencies: {steps:?}"));
        println!("{}", installed.1);
        let answered = steps
            .iter()
            .find(|(step, detail)| {
                step == "bot" && detail.starts_with("The built-in Bot is answering (/health")
            })
            .unwrap_or_else(|| panic!("the Bot never answered in {steps:?}"));
        println!("the Bot step said: {}", answered.1);
        assert!(answered.1.contains("/health 200"), "{}", answered.1);
        let bot_port = started.bot_port.expect("this release ships a built-in Bot");
        assert_eq!(
            health_status(&bot_address(bot_port)).expect("the Bot answers"),
            200
        );

        let mut children = vec![started.server, started.worker];
        if let Some(bot) = started.bot {
            children.push(bot);
        }
        if let Some(computer) = started.computer {
            children.push(computer);
        }
        stop(&root, &mut children).expect("stopping the local stack");
        println!("the fresh checkout is at {}", root.display());
    }

    /// The links bun makes are absolute, so a checkout that moved has to be linked again.
    #[test]
    fn a_checkout_that_moved_is_linked_again() {
        let root = scratch("links");
        assert!(
            !workspace_links_land_here(&root),
            "nothing is linked before anything is installed"
        );

        // Real folders rather than symlinks: creating a link needs privileges a test should not
        // demand, and the question here is whether the link resolves inside this root, not how it
        // came to be one.
        for name in ["shared", "toolkit", "recorder-extension"] {
            std::fs::create_dir_all(root.join("node_modules").join("@ccpbot").join(name))
                .expect("a workspace folder");
        }
        assert!(
            workspace_links_land_here(&root),
            "links that land here are fine"
        );

        // A checkout that was moved keeps folders that point outside itself, which is the state that
        // makes the server die with `Cannot find module '@ccpbot/shared/…'`.
        let elsewhere = std::env::temp_dir().join("ccpbot-local-somewhere-else");
        std::fs::create_dir_all(&elsewhere).expect("a folder outside the checkout");
        std::fs::remove_dir_all(root.join("node_modules").join("@ccpbot").join("shared"))
            .expect("the stale link");
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(
            &elsewhere,
            root.join("node_modules").join("@ccpbot").join("shared"),
        )
        .expect("a link to somewhere else");
        assert!(
            !workspace_links_land_here(&root),
            "a link out of this checkout is what has to be repaired"
        );

        let _ = std::fs::remove_dir_all(&elsewhere);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_folder_of_its_own_is_used_until_a_person_points_elsewhere() {
        let root = scratch("workspace-choice");
        assert_eq!(
            workspace_folder(&root),
            root.join(WORKSPACE_FOLDER),
            "a checkout nobody has pointed anywhere works in a folder of its own"
        );

        // A blank line is not a choice: the pointer exists but names nowhere.
        std::fs::write(root.join(WORKSPACE_FILE), "   \n").expect("the pointer");
        assert_eq!(workspace_folder(&root), root.join(WORKSPACE_FOLDER));

        let chosen = root.join("my-own-project");
        let remembered = set_workspace_folder(&root, &chosen).expect("the choice");
        assert_eq!(remembered, chosen);
        assert_eq!(
            workspace_folder(&root),
            chosen,
            "the person's folder is the one the computer is told about"
        );
        assert_eq!(
            std::fs::read_to_string(root.join(WORKSPACE_FILE))
                .expect("the pointer")
                .trim(),
            chosen.display().to_string()
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_computer_is_told_which_folder_to_work_in() {
        let root = scratch("computer-env");
        let secrets: BTreeMap<String, String> = [("COMPUTER_TOKEN", "token-1234")]
            .into_iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect();
        let workspace = root.join("my-own-project");
        std::fs::create_dir_all(&workspace).expect("a folder to work in");

        let environment = computer_environment(&root, 6210, &secrets, &workspace);

        assert_eq!(environment.get("PORT"), Some(&"6210".to_string()));
        assert_eq!(
            environment.get("COMPUTER_TOKEN"),
            Some(&"token-1234".to_string())
        );
        assert_eq!(
            environment.get("WORKSPACE_DIR"),
            Some(&workspace.display().to_string()),
            "the folder a Bot works in is the person's, not one of ours"
        );
        assert_eq!(
            environment.get("COMPUTER_BOT_ID"),
            Some(&"shared".to_string())
        );
        let browsers = environment
            .get("PLAYWRIGHT_BROWSERS_PATH")
            .expect("the browser folder");
        assert!(
            browsers.starts_with(&root.join(COMPUTER_FOLDER).display().to_string()),
            "the browser stays under this deployment, away from the shared cache: {browsers}"
        );
        assert!(
            !environment.contains_key("COMPUTER_PEOPLE_ONLY"),
            "that mark belongs to the browser a person watches, not to a Bot's computer"
        );

        let _ = std::fs::remove_dir_all(&root);
    }
}
