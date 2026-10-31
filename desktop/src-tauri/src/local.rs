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
use std::process::{Child, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use crate::install::{self, Download};
use crate::problem::Problem;
use crate::quiet;

/// One platform's copy of something this mode fetches: where it comes from, what it is called, and
/// what it has to hash to before anything is unpacked or run.
///
/// Data rather than `#[cfg]`-selected constants, so that every row is compiled and can be asserted
/// on every machine: the macOS row is checked by the tests on Windows, where the macOS branch itself
/// cannot run. The digest is what was actually unpacked and run; a version is what somebody hoped
/// would be served.
pub struct Asset {
    pub url: &'static str,
    pub file: &'static str,
    pub sha256: &'static str,
}

/// The portable PostgreSQL this mode is built against: EDB's binaries zip, which needs no installer
/// and no administrator — unzip it anywhere and it runs.
///
/// Windows: measured 329,891,687 bytes on a real machine, and the first attempt at downloading it
/// was cut short by the server, which is exactly the sort of thing a digest catches. macOS: the same
/// publisher's universal build, 358,923,135 bytes, whose `bin/{postgres,initdb,pg_ctl,pg_config}`
/// all carry the arm64 slice and whose libraries are found through `@loader_path`, so the tree can be
/// moved anywhere. Both archives hold `pgsql/` at their top level, so unpacking leaves one shape.
pub const WINDOWS_POSTGRES: Asset = Asset {
    url: "https://get.enterprisedb.com/postgresql/postgresql-17.6-1-windows-x64-binaries.zip",
    file: "postgresql-17.6-1-windows-x64-binaries.zip",
    sha256: "d378882abd001a186735acd6f6ba716bca6ccd192e800412d4fd15ed25376b3e",
};
pub const MACOS_POSTGRES: Asset = Asset {
    url: "https://get.enterprisedb.com/postgresql/postgresql-17.6-1-osx-binaries.zip",
    file: "postgresql-17.6-1-osx-binaries.zip",
    sha256: "5afb85f5d764176bb00a527cfc5dd9127b9f8efaa33f5a9afbedbf6ceb985fcc",
};

/// The archive that platform's portable server comes in, or nothing if this mode does not serve it.
pub fn postgres_asset(os: &str) -> Option<Asset> {
    match os {
        "windows" => Some(WINDOWS_POSTGRES),
        "macos" => Some(MACOS_POSTGRES),
        _ => None,
    }
}

pub const POSTGRES_FOLDER: &str = "postgres";
/// What the EDB archive holds at its top level, so that is where unpacking leaves the binaries.
pub const POSTGRES_UNPACKED: &str = "pgsql";

/// The pgvector build for the portable server above: on Windows the binaries the extension's own
/// documentation points at, on macOS this project's own build of it, published as a release asset.
///
/// The first migration is `CREATE EXTENSION IF NOT EXISTS vector;`, and the EDB build does not
/// bundle the extension — a container gets it from the `pgvector/pgvector` image, a machine running
/// PostgreSQL itself has to be handed one. Without it the very first migration stops with
/// `extension "vector" is not available`, and nothing after it runs.
///
/// The macOS build is pinned by digest (75,225 bytes) rather than compiled on the machine that wants
/// it: a zip carries timestamps, so rebuilding it would change the digest and undo the pin. It was
/// built for arm64 with a Ventura deployment target and links the system library alone, and it holds
/// its three files at the top level — which is why placing them looks for file names rather than for
/// the folder shape the Windows archive happens to have.
pub struct VectorAsset {
    pub download: Asset,
    /// The library the server loads: the same extension, named the way each platform names one.
    pub library: &'static str,
}
pub const WINDOWS_VECTOR: VectorAsset = VectorAsset {
    download: Asset {
        url: "https://github.com/andreiramani/pgvector_pgsql_windows/releases/download/0.8.6_17/vector.v0.8.6-pg17.zip",
        file: "vector.v0.8.6-pg17.zip",
        sha256: "420388e9e9f05d92f06d6967ce8772483629b27a66ca9255925fa0fdd445438e",
    },
    library: "vector.dll",
};
pub const MACOS_VECTOR: VectorAsset = VectorAsset {
    download: Asset {
        url: "https://github.com/DamonZS/CCP-Bot/releases/download/pgvector-0.8.6/pgvector-macos-arm64.zip",
        file: "pgvector-macos-arm64.zip",
        sha256: "1486659e0fd58bb4a253a69bc5c8dc3a03f806649cd8172e7ec06b3855d8fa16",
    },
    library: "vector.dylib",
};

/// The extension archive that platform's server is given, or nothing if this mode does not serve it.
pub fn vector_asset(os: &str) -> Option<VectorAsset> {
    match os {
        "windows" => Some(WINDOWS_VECTOR),
        "macos" => Some(MACOS_VECTOR),
        _ => None,
    }
}

/// The library file name this platform's server loads.
pub fn vector_library() -> &'static str {
    vector_asset(std::env::consts::OS)
        .unwrap_or(WINDOWS_VECTOR)
        .library
}

/// Whether this machine can run CCP-Bot the local way at all.
///
/// True where this mode has a portable database of its own to unpack; anywhere else the container
/// route is the answer, and the window is told so before it offers the choice.
pub fn supported_here() -> bool {
    postgres_asset(std::env::consts::OS).is_some()
}

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
/// Where those browsers keep their profiles: the logins a Bot signed into, one folder per Bot.
///
/// Its own folder rather than the browsers': the program and the profile are different things to
/// lose, and `agent-computer` refuses to start when the folder it is told about cannot be written.
pub const PROFILES_FOLDER: &str = "profiles";

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

/// The archive to unpack for this platform, or why there is not one.
///
/// Windows and macOS are both wired up: each has a portable build of the same database, so a machine
/// that has never had PostgreSQL installed can run one out of a folder. Any other platform is still
/// served by the container route, and says so here rather than starting something it cannot finish.
pub fn postgres() -> Result<Download, Problem> {
    let asset = postgres_asset(std::env::consts::OS).ok_or_else(|| {
        Problem::with(
            "Local mode ships a portable database for Windows and macOS only.",
            format!(
                "no portable PostgreSQL is wired up for {} on {}",
                std::env::consts::OS,
                std::env::consts::ARCH
            ),
        )
    })?;
    Ok(Download {
        url: asset.url.to_string(),
        sha256: asset.sha256,
        file: asset.file,
    })
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

/// What the bundled Bot needs in its environment.
///
/// Its token first: the process holds a model credential and refuses to start without one
/// (`agent-bot/src/index.ts` exits when the variable is absent). Its port second. The model's keys
/// come along through `hand_the_model_keys`: a key is a credential, so it travels as environment
/// rather than in the file a person can open.
pub fn bot_environment(port: u16, secrets: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut environment: BTreeMap<String, String> = [
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
    .collect();
    hand_the_model_keys(secrets, &mut environment);
    environment
}

/// Hands one child the model's keys, which live in this machine's credential store.
///
/// `--env-file` only fills in what the environment does not already carry: measured on the runtime
/// this ships (bun 1.4.3, and 1.2.21 before it), a variable that is already set wins over the file,
/// so a key handed over here reaches the process even though the file deliberately holds no key.
/// Which keys these are is `env::MODEL_KEYS` — the same list the writer splits on, not a second one.
fn hand_the_model_keys(
    secrets: &BTreeMap<String, String>,
    environment: &mut BTreeMap<String, String>,
) {
    for key in crate::env::MODEL_KEYS {
        if let Some(value) = secrets.get(key).filter(|value| !value.trim().is_empty()) {
            environment.insert(key.to_string(), value.clone());
        }
    }
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

/// Where the computer's browsers keep their profiles, also out of the workspace a Bot may delete.
///
/// The computer is told this rather than left to guess: its own fallback is `/profiles`, and a machine
/// whose root cannot be written (measurably: an Apple silicon runner, `EROFS`) makes it refuse to
/// start instead of running a browser whose profile is thrown away.
pub fn profiles_folder(root: &Path) -> PathBuf {
    computer_folder(root).join(PROFILES_FOLDER)
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
///
/// The model's keys come along the same way a container's environment carries them to every service,
/// through `hand_the_model_keys` rather than through the file.
pub fn computer_environment(
    root: &Path,
    port: u16,
    secrets: &BTreeMap<String, String>,
    workspace: &Path,
) -> BTreeMap<String, String> {
    let mut environment: BTreeMap<String, String> = [
        ("PORT", port.to_string()),
        (
            "COMPUTER_TOKEN",
            secrets.get("COMPUTER_TOKEN").cloned().unwrap_or_default(),
        ),
        ("WORKSPACE_DIR", workspace.display().to_string()),
        ("COMPUTER_BOT_ID", "shared".to_string()),
        ("PROFILES_DIR", profiles_folder(root).display().to_string()),
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
    .collect();
    hand_the_model_keys(secrets, &mut environment);
    environment
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

/// The pgvector archive for this platform, or why there is not one.
pub fn vector() -> Result<Download, Problem> {
    let asset = vector_asset(std::env::consts::OS).ok_or_else(|| {
        Problem::with(
            "Running CCP-Bot on this computer is not implemented here yet.".to_string(),
            format!(
                "no portable database extension is wired up for {} on {}",
                std::env::consts::OS,
                std::env::consts::ARCH
            ),
        )
    })?;
    Ok(Download {
        url: asset.download.url.to_string(),
        sha256: asset.download.sha256,
        file: asset.download.file,
    })
}

/// Where a platform's portable server keeps its own libraries and extension files, relative to the
/// unpacked archive.
///
/// Windows follows the plain install layout, `lib/` and `share/extension/`. The macOS build puts both
/// one level deeper, in `lib/postgresql/` and `share/postgresql/extension/`, because that build's
/// `SHAREDIR` is `share/postgresql`. Same files, two shapes, and the server looks in only one of
/// them — so this has to follow the platform rather than be assumed.
pub struct Tree {
    pub lib: &'static [&'static str],
    pub extension: &'static [&'static str],
}
pub const WINDOWS_TREE: Tree = Tree {
    lib: &["lib"],
    extension: &["share", "extension"],
};
pub const MACOS_TREE: Tree = Tree {
    lib: &["lib", "postgresql"],
    extension: &["share", "postgresql", "extension"],
};

/// That platform's layout, or nothing if this mode does not serve it.
pub fn tree(os: &str) -> Option<Tree> {
    match os {
        "windows" => Some(WINDOWS_TREE),
        "macos" => Some(MACOS_TREE),
        _ => None,
    }
}

fn under(root: PathBuf, parts: &[&str]) -> PathBuf {
    parts.iter().fold(root, |path, part| path.join(part))
}

/// Where one platform's server keeps the libraries it loads.
pub fn lib_folder_on(root: &Path, os: &str) -> PathBuf {
    under(unpacked_folder(root), tree(os).unwrap_or(WINDOWS_TREE).lib)
}

/// Where one platform's server looks for extensions: one control file and its scripts per extension.
pub fn extension_folder_on(root: &Path, os: &str) -> PathBuf {
    under(
        unpacked_folder(root),
        tree(os).unwrap_or(WINDOWS_TREE).extension,
    )
}

pub fn lib_folder(root: &Path) -> PathBuf {
    lib_folder_on(root, std::env::consts::OS)
}

pub fn extension_folder(root: &Path) -> PathBuf {
    extension_folder_on(root, std::env::consts::OS)
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
/// are simply never copied.
///
/// The three files are found by name rather than by folder shape: the Windows archive is a
/// PostgreSQL layout with `lib/` and `share/extension/`, while this project's macOS build holds its
/// files at the top level. The server needs the same three either way, so the names decide and the
/// folders do not.
pub fn place_vector(root: &Path, staging: &Path) -> Result<(), Problem> {
    let library = find_file(staging, vector_library()).ok_or_else(|| {
        Problem::with(
            "The unpacked extension has no library in it.".to_string(),
            format!("{} holds no {}", staging.display(), vector_library()),
        )
    })?;
    let control = find_file(staging, VECTOR_CONTROL).ok_or_else(|| {
        Problem::with(
            "The unpacked extension has no control file in it.".to_string(),
            format!("{} holds no {}", staging.display(), VECTOR_CONTROL),
        )
    })?;
    let scripts: Vec<PathBuf> = files_under(staging)
        .into_iter()
        .filter(|path| is_vector_script(path))
        .collect();
    if scripts.is_empty() {
        return Err(Problem::with(
            "The unpacked extension is not laid out the way it is expected to be.".to_string(),
            format!("{} holds no vector--*.sql script", staging.display()),
        ));
    }
    copy_into(&library, &lib_folder(root))?;
    copy_into(&control, &extension_folder(root))?;
    for script in scripts {
        copy_into(&script, &extension_folder(root))?;
    }
    Ok(())
}

/// The scripts a control file names: `vector--0.8.6.sql` beside `vector.control`.
fn is_vector_script(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("vector--") && name.ends_with(".sql"))
}

/// Finds one file by name anywhere under a folder, or nothing if it is not there.
fn find_file(root: &Path, name: &str) -> Option<PathBuf> {
    files_under(root)
        .into_iter()
        .find(|path| path.file_name().is_some_and(|file| file == name))
}

/// Every file under a folder, in one stable order, without following symbolic links.
///
/// The extension archives are small — three files either way — so walking one is cheaper than
/// knowing its shape, which is the thing that differs between the platforms.
fn files_under(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut folders = vec![root.to_path_buf()];
    while let Some(folder) = folders.pop() {
        let Ok(entries) = std::fs::read_dir(&folder) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            match std::fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.is_dir() => folders.push(path),
                Ok(_) => found.push(path),
                Err(_) => continue,
            }
        }
    }
    found.sort();
    found
}

/// Copies one file into a folder, creating the folder, and gives back where it landed.
fn copy_into(from: &Path, to: &Path) -> Result<PathBuf, Problem> {
    std::fs::create_dir_all(to).map_err(|error| {
        Problem::with(
            "Local mode could not create its database library folder.".to_string(),
            format!("creating {} failed: {error}", to.display()),
        )
    })?;
    let target = to.join(from.file_name().unwrap_or_default());
    std::fs::copy(from, &target).map_err(|error| {
        Problem::with(
            "The database extension could not be placed.".to_string(),
            format!("copying {} failed: {error}", target.display()),
        )
    })?;
    Ok(target)
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

/// Unpack a zip with the `zip` crate, which is also what rebuilds the links inside it.
///
/// Two things the Windows unzipper does not have to think about. The macOS database archive holds
/// 119 symbolic links, and a link unpacked as a plain file is 19 bytes of text where the server
/// expects a library — the build does not start without them, so each is re-created as a link. And
/// `pgAdmin 4.app` is 741 MB of the 980 MB that archive expands to, none of which the server runs.
#[cfg(unix)]
fn unpack(archive: &Path, destination: &Path) -> Result<(), Problem> {
    let file = std::fs::File::open(archive).map_err(|error| {
        Problem::with(
            "Unpacking the portable database failed.".to_string(),
            format!("opening {} failed: {error}", archive.display()),
        )
    })?;
    let mut zip = zip::ZipArchive::new(file).map_err(|error| {
        Problem::with(
            "Unpacking the portable database failed.".to_string(),
            format!("reading {} as a zip failed: {error}", archive.display()),
        )
    })?;
    std::fs::create_dir_all(destination).map_err(|error| {
        Problem::with(
            "Unpacking the portable database failed.".to_string(),
            format!("creating {} failed: {error}", destination.display()),
        )
    })?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|error| {
            Problem::with(
                "Unpacking the portable database failed.".to_string(),
                format!(
                    "reading entry {index} of {} failed: {error}",
                    archive.display()
                ),
            )
        })?;
        let Some(name) = entry.enclosed_name() else {
            continue;
        };
        if skipped_entry(&name.to_string_lossy()) {
            continue;
        }
        let path = destination.join(&name);
        if entry.is_dir() {
            let _ = std::fs::create_dir_all(&path);
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                Problem::with(
                    "Unpacking the portable database failed.".to_string(),
                    format!("creating {} failed: {error}", parent.display()),
                )
            })?;
        }
        let mode = entry.unix_mode();
        if mode.is_some_and(is_symlink) {
            let mut target = String::new();
            entry.read_to_string(&mut target).map_err(|error| {
                Problem::with(
                    "Unpacking the portable database failed.".to_string(),
                    format!("reading the link {} failed: {error}", path.display()),
                )
            })?;
            let _ = std::fs::remove_file(&path);
            std::os::unix::fs::symlink(target.trim_end_matches('\n'), &path).map_err(|error| {
                Problem::with(
                    "Unpacking the portable database failed.".to_string(),
                    format!("linking {} failed: {error}", path.display()),
                )
            })?;
            continue;
        }
        let mut written = std::fs::File::create(&path).map_err(|error| {
            Problem::with(
                "Unpacking the portable database failed.".to_string(),
                format!("creating {} failed: {error}", path.display()),
            )
        })?;
        std::io::copy(&mut entry, &mut written).map_err(|error| {
            Problem::with(
                "Unpacking the portable database failed.".to_string(),
                format!("writing {} failed: {error}", path.display()),
            )
        })?;
        drop(written);
        if let Some(mode) = mode {
            // The programs have to come out runnable: `bin/postgres` is useless without it.
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode & 0o7777));
        }
    }
    Ok(())
}

/// Whether an entry is one this mode deliberately leaves in the archive.
///
/// Compared path segment by path segment: the application is a folder at an archive's top level,
/// and anything inside it is skipped with it.
#[cfg(any(unix, test))]
fn skipped_entry(name: &str) -> bool {
    name.split('/').any(|part| part == "pgAdmin 4.app")
}

/// Whether a zip entry is a symbolic link, which is what its mode says it is.
#[cfg(any(unix, test))]
fn is_symlink(mode: u32) -> bool {
    mode & 0o170000 == 0o120000
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

/// The postmaster's own file, written while it runs and removed when it stops.
const POSTMASTER_PID: &str = "postmaster.pid";

/// How long the loopback is given to answer before the database counts as not running.
const DATABASE_PROBE: Duration = Duration::from_millis(250);

/// Whether the cluster is already answering.
///
/// Asked of the machine, not of `pg_ctl`: the window that shows a run's progress reads this once a
/// second, and a `pg_ctl status` is a whole process per read. Measured on a published installer:
/// four `pg_ctl` processes from one first run outlived it, two of them sitting on a Windows error
/// box, and a helper that never exits is a read that never returns. What is read here instead is the
/// postmaster's pid file and the port it was told to answer on — two facts, no process.
pub fn postgres_running(root: &Path) -> bool {
    if !data_folder(root).join(POSTMASTER_PID).is_file() {
        return false;
    }
    let Some(port) = remembered_port(root) else {
        return false;
    };
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    std::net::TcpStream::connect_timeout(&address, DATABASE_PROBE).is_ok()
}

/// The last few lines of a file, for the failures only the log knows about.
///
/// `pg_ctl` cannot be asked for its output (see the start below), so the reason a database refused
/// to come up is read from where it was written instead of being invented.
fn tail_of(path: &Path, lines: usize) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let written: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    if written.is_empty() {
        return format!("{} holds nothing to read", path.display());
    }
    let start = written.len().saturating_sub(lines);
    written[start..].join("\n")
}

/// Every log this run wrote, for a failure that has to explain itself on a machine nobody can look
/// at afterwards.
///
/// The same reasoning as the computer's own failure carrying its log, one level up: a test that
/// dies on a runner is deleted together with the runner, so the reason it died has to travel in the
/// text. Read with `tail_of`, the way the database and the computer are.
pub fn logs_on_failure(root: &Path) -> String {
    ["server", "bot", "computer", "postgres"]
        .iter()
        .map(|name| {
            let path = log_file(root, name);
            format!("===== {} =====\n{}", path.display(), tail_of(&path, 40))
        })
        .collect::<Vec<String>>()
        .join("\n")
}

/// How long a stopping `pg_ctl -w` is given before it is treated as one that never comes back.
const STOP_PATIENCE: Duration = Duration::from_secs(30);

/// Waits for a helper this mode started, and does not wait forever.
///
/// A helper is this mode's to finish. `pg_ctl start` is given its own budget for the work (`-t`), so
/// the wait here is longer than any answer it can still legitimately be working on; what it catches
/// is the helper that never answers at all. A process sitting on a Windows error box does not exit,
/// and its parent waiting on it does not return — measured on a published installer, that is how
/// `pg_ctl` processes outlived a run. `None` means it had to be killed, and the caller then asks the
/// machine what actually happened rather than trusting the helper's word.
fn waited(child: &mut Child, patience: Duration) -> Result<Option<ExitStatus>, Problem> {
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(Some(status)),
            Ok(None) => {}
            Err(error) => {
                return Err(Problem::with(
                    "The local database tool could not be waited for.".to_string(),
                    format!("waiting for pg_ctl failed: {error}"),
                ))
            }
        }
        if started.elapsed() >= patience {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(25));
    }
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
    let patience = POSTGRES_TIMEOUT + Duration::from_secs(20);
    let mut helper = quiet::command(tool(root, "pg_ctl"))
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
        .spawn()
        .map_err(|error| {
            Problem::with(
                "The local database would not start.".to_string(),
                format!("running pg_ctl failed: {error}"),
            )
        })?;
    match waited(&mut helper, patience)? {
        Some(status) if status.success() => Ok(()),
        // A helper that had to be killed leaves a database that may well have come up anyway: the
        // start is the postmaster's work, not the helper's, so the machine is asked.
        None if postgres_running(root) => Ok(()),
        Some(_) => Err(Problem::with(
            "The local database would not start.".to_string(),
            tail_of(&log, 6),
        )),
        None => Err(Problem::with(
            "The local database would not start.".to_string(),
            format!(
                "pg_ctl did not come back within {}s and was stopped.\n\n{}",
                patience.as_secs(),
                tail_of(&log, 6)
            ),
        )),
    }
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
    let mut helper = quiet::command(tool(root, "pg_ctl"))
        .args(["-D", data_text.as_str(), "-m", "fast", "-w", "stop"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            Problem::with(
                "The local database would not stop.".to_string(),
                format!("running pg_ctl failed: {error}"),
            )
        })?;
    match waited(&mut helper, STOP_PATIENCE)? {
        Some(status) if status.success() => Ok(()),
        // A database that stopped while its helper sat there is still a database that stopped.
        None if !postgres_running(root) => Ok(()),
        Some(_) => Err(Problem::with(
            "The local database would not stop.".to_string(),
            tail_of(&log, 6),
        )),
        None => Err(Problem::with(
            "The local database would not stop.".to_string(),
            format!(
                "pg_ctl did not come back within {}s and was stopped.\n\n{}",
                STOP_PATIENCE.as_secs(),
                tail_of(&log, 6)
            ),
        )),
    }
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
    let mut command = quiet::command(bun);
    command
        .args(arguments)
        .envs(environment.iter())
        .current_dir(working)
        .stdin(std::process::Stdio::null())
        .stdout(stdout)
        .stderr(stderr);
    in_its_own_group(&mut command);
    command.spawn().map_err(|error| {
        Problem::with(
            format!("Starting {} failed.", arguments.join(" ")),
            format!("spawning bun in {} failed: {error}", working.display()),
        )
    })
}

/// Puts a service in a process group of its own, so that stopping it stops everything it started.
///
/// On Unix a signal to a parent does not reach its children, and the services here do spawn their
/// own: `bun` runs the server in the same process, but a worker starts children of its own. Without
/// a group, ending the parent would leave them behind holding their ports. On Windows the tree is
/// stopped by `taskkill /T` instead, so there is nothing to set up here.
fn in_its_own_group(command: &mut std::process::Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // A group of its own, the one `end` signals by the child's process id.
        command.process_group(0);
    }
    #[cfg(not(unix))]
    let _ = command;
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
/// Writes the model the model screen chose where the two routes keep it: the credentials into this
/// machine's own store, the settings into `.env`, through the one rule the container route also uses
/// (`env::model_environment`), so the two routes cannot disagree about what a choice means.
///
/// Why this is needed at all: the built-in Bot is a process on this machine, and it hears about a
/// model only from its environment — the one its parent hands it, and the file `--env-file` fills in
/// around that. Measured on a published installer — the wizard's answer reached neither `.env` nor
/// the credential store, and the Bot exited on startup saying `OPENAI_API_KEY is not set, and no
/// OPENAI_BASE_URL names an endpoint that needs no key.` A person who had just answered the model
/// screen was then told the Bot cannot answer without a model. This is the missing half of that
/// round trip.
///
/// A key is a credential, and a credential does not belong in a file somebody can open and paste
/// into a chat, so the split is `vault::is_secret`'s rather than a second list: `OPENAI_API_KEY` and
/// its siblings go to the store and reach the children as environment (`hand_the_model_keys`), while
/// `BOT_MODEL`, `OPENAI_BASE_URL` and the rest stay in the file. `purge` takes out of the file every
/// key of the rule this answer did not produce — including the copy an earlier version wrote there.
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
    let (settings, secrets) =
        crate::vault::split(crate::env::model_environment(credential, server_port));
    let mut purge = secrets.clone();
    for key in crate::env::MODEL_KEYS {
        if !settings.contains_key(key) {
            purge.insert(key.to_string(), String::new());
        }
    }
    crate::vault::write_env_after_remembering(root, &root.join(".env"), &settings, &secrets, &purge)
        .map_err(|problem| {
            Problem::with(
                "The model choice could not be saved.",
                problem.detail.unwrap_or(problem.said),
            )
        })
}

/// Refuses a local run that has no answer to give the Bot, before it starts downloading anything.
///
/// The Bot is started with `--env-file=.env` plus the environment its parent hands it, so a machine
/// with nothing to answer with gets a Bot that exits on startup — measured on a published installer:
/// `OPENAI_API_KEY is not set, and no OPENAI_BASE_URL names an endpoint that needs no key.` Waiting
/// minutes for the runtime, the database and PostgreSQL before saying that is no service to anyone,
/// so the answer is checked first.
///
/// A machine whose file already carries a key was told nothing this run, and either half of an answer
/// counts: the store this mode keeps, or a key in the file a person typed or pasted.
pub fn require_a_model(
    root: &Path,
    credential: Option<&crate::env::ModelCredential>,
) -> Result<(), Problem> {
    if credential.is_some() || a_model_is_named(root) {
        return Ok(());
    }
    Err(Problem::with(
        "CCP-Bot is waiting for a model.",
        "The built-in Bot cannot answer without one. Choose a model in CCP-Bot's model screen, or put a key in the folder's `.env` file, and start again.",
    ))
}

/// Whether this folder already has an answer to hand the Bot: a credential in this machine's store,
/// or one set in the file. `OPENAI_BASE_URL` counts, which is how a keyless endpoint is named.
fn a_model_is_named(root: &Path) -> bool {
    let stored = crate::vault::recall_all(root, &crate::env::MODEL_KEYS)
        .map(|named| !named.is_empty())
        .unwrap_or(false);
    stored || !crate::env::already_set(&root.join(".env"), &crate::env::MODEL_KEYS).is_empty()
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

/// Whether this folder already holds the sources local mode runs.
///
/// `package.json` is the whole test: it is what every step afterwards reads, and a folder that has
/// it has been fetched (or cloned) already.
pub fn checkout_ready(root: &Path) -> bool {
    root.join("package.json").is_file()
}

/// Fetches the published sources into an empty folder, once.
///
/// The version is this build's own release when there is one — `deployment_release` chooses, and
/// falls back to the latest release only for a version that has none — and the fetch is the same one
/// the window's other route uses: the tarball the release publishes, unpacked into the folder.
/// Nothing here is local mode's own idea of where sources come from — if the release moves, both
/// routes move with it.
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
    let mut secrets = deployment_secrets(root)?;
    // The model screen's credentials are secrets, so they are not in `.env` — that is the line
    // `vault::is_secret` draws — and they reach the children below as environment instead: the file
    // `--env-file` names fills in only what the process environment does not already set.
    for (key, value) in crate::vault::recall_all(root, &crate::env::MODEL_KEYS)? {
        if !value.trim().is_empty() {
            secrets.insert(key, value);
        }
    }
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
                    // Why it never came up is written in the computer's own log, and nothing else
                    // prints that file: without this the failure reads as a port that stayed silent.
                    let log = tail_of(&log_file(root, "computer"), 80);
                    Problem::with(
                        "The computer did not answer.".to_string(),
                        format!(
                            "{address} never answered /health. Last time: {last}\n\nThe computer's log:\n{log}"
                        ),
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
        // The secrets this deployment minted, and nothing else: a local run has no CopilotKit account
        // behind it, and a connection somebody configured is in the file `../.env` names, which the
        // server reads for itself. What used to stand in for one here is gone with the check that
        // demanded it — the server now says `intelligence-absent` and runs on this machine's tables.
        &secrets,
    )?;
    // The worker is handed its three settings and the model's keys, the way compose hands its one
    // environment to every service: it does not read the deployment's configuration, and the less
    // this process holds the less a mistake in it can spend.
    let mut worker_environment: BTreeMap<String, String> = [
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
    hand_the_model_keys(&secrets, &mut worker_environment);
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
/// and neither platform takes the children down with the parent by itself — which is how a port
/// stays taken after the window is gone. On Windows `taskkill /T` walks the tree; on Unix the child
/// leads the group `in_its_own_group` gave it, and the signal goes to the whole group at once.
pub fn end(child: &mut Child) {
    #[cfg(windows)]
    {
        let pid = child.id().to_string();
        let _ = quiet::command("taskkill")
            .args(["/PID", pid.as_str(), "/T", "/F"])
            .output();
    }
    #[cfg(unix)]
    {
        let group = child.id() as i32;
        // Naming the group is the only way to reach grandchildren; the direct kill below reaches
        // the leader itself either way.
        unsafe {
            libc::killpg(group, libc::SIGKILL);
        }
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

    /// A local run invents no connection of its own, and one somebody configured is theirs to keep.
    ///
    /// `server/src/config.ts` used to refuse to start without the three values, and this route
    /// answered for itself with `http://127.0.0.1:9/api`. All three absent is now a deployment that
    /// means to stand on its own, so the wizard's answer is the only source: written by
    /// `write_intelligence`, and left alone by every later `write_env`.
    #[test]
    fn a_run_on_this_computer_writes_no_connection_of_its_own() {
        let root = scratch("intelligence-none");
        write_env(&root, 63133, Some(4211), Some(6210)).expect("writing .env");
        let written = std::fs::read_to_string(root.join(".env")).expect("the .env");
        assert!(!written.contains("INTELLIGENCE"), "{written}");

        write_intelligence(
            &root,
            "https://api.example",
            "wss://api.example/gateway",
            "sk-service",
        )
        .expect("writing the connection");
        write_env(&root, 63133, Some(4211), Some(6210)).expect("writing .env again");
        let kept = std::fs::read_to_string(root.join(".env")).expect("the .env");
        assert!(
            kept.contains("INTELLIGENCE_API_URL=https://api.example"),
            "{kept}"
        );
        assert!(kept.contains("INTELLIGENCE_API_KEY=sk-service"), "{kept}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A failure only the log knows about is read from the log rather than invented: the last few
    /// lines of a file, and an honest "nothing to read" when there is no file there at all.
    #[test]
    fn a_failure_is_read_from_the_last_lines_of_the_log() {
        let root = scratch("tail");
        std::fs::create_dir_all(logs_folder(&root)).expect("the logs folder");
        let log = log_file(&root, "postgres");
        std::fs::write(&log, "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n").expect("a log");
        let tail = tail_of(&log, 6);
        assert!(tail.contains("eight"), "{tail}");
        assert!(tail.contains("three"), "{tail}");
        assert!(!tail.contains("one"), "{tail}");
        assert!(!tail.contains("two"), "{tail}");

        let missing = tail_of(&root.join("nowhere.log"), 6);
        assert!(missing.contains("nothing to read"), "{missing}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Whether the database runs is answered from the postmaster's own evidence, without starting a
    /// helper: the window asks once a second, and a helper that never exits is a read that never
    /// returns. There is no `pg_ctl` in this root at all, so nothing could have been started.
    #[test]
    fn a_running_database_is_answered_by_the_machine_without_a_helper() {
        let root = scratch("database-probe");
        std::fs::create_dir_all(data_folder(&root)).expect("the data folder");
        let listener = TcpListener::bind("127.0.0.1:0").expect("a port to answer on");
        let port = listener.local_addr().expect("the address").port();
        std::fs::write(port_file(&root), port.to_string()).expect("the port");

        // A port that answers is not the answer on its own: the file is the postmaster's.
        assert!(!postgres_running(&root), "no postmaster, no database");
        std::fs::write(data_folder(&root).join(POSTMASTER_PID), "1\n").expect("a pid file");
        assert!(
            postgres_running(&root),
            "the postmaster's file and its port"
        );
        drop(listener);
        assert!(!postgres_running(&root), "the port stopped answering");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A helper this mode starts is this mode's to finish: one that never comes back is killed
    /// rather than waited on forever. On a published installer, `pg_ctl` sat on a Windows error box
    /// and outlived the run that started it, with the parent that waited on it not returning.
    #[test]
    fn a_helper_that_never_comes_back_is_killed() {
        #[cfg(windows)]
        let mut child = quiet::command("cmd")
            .args(["/c", "ping", "-n", "30", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("a helper to wait for");
        #[cfg(not(windows))]
        let mut child = quiet::command("/bin/sleep")
            .args(["30"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("a helper to wait for");

        let outcome = waited(&mut child, Duration::from_millis(300)).expect("waiting for it");
        assert!(outcome.is_none(), "the helper had to be stopped");
        assert!(
            child.try_wait().expect("asking after it").is_some(),
            "the killed helper is reaped, not left behind"
        );
    }

    /// A live test that dies on a runner takes the logs with it, so this block is what has to
    /// explain the death: it names every log, reads the one that was written, and says so honestly
    /// where there is nothing to read.
    #[test]
    fn a_failure_message_carries_the_logs_this_run_wrote() {
        let root = scratch("failure-logs");
        std::fs::create_dir_all(logs_folder(&root)).expect("the logs folder");
        std::fs::write(log_file(&root, "server"), "one\ntwo\nthree\n").expect("a log");

        let carried = logs_on_failure(&root);
        assert!(carried.contains("local-server.log"), "{carried}");
        assert!(carried.contains("three"), "{carried}");
        assert!(carried.contains("local-computer.log"), "{carried}");
        assert!(carried.contains("nothing to read"), "{carried}");
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
        std::fs::write(staging.join("lib").join(vector_library()), "dll").expect("a library");
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
        assert!(lib_folder(&root).join(vector_library()).is_file());
        assert!(vector_installed(&root));
        let scripts = extension_folder(&root);
        assert!(scripts.join("vector--0.8.6.sql").is_file());
        assert!(!unpacked_folder(&root).join("include").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Both platforms' asset rows are compiled in, so a Windows machine can assert what the macOS
    /// one will fetch and unpack — the digest is the one that was actually measured, not a version
    /// somebody hoped for.
    #[test]
    fn every_platforms_assets_are_pinned_by_digest() {
        let windows = postgres_asset("windows").expect("the Windows database");
        let macos = postgres_asset("macos").expect("the macOS database");
        assert!(windows.file.ends_with("windows-x64-binaries.zip"));
        assert_eq!(macos.file, "postgresql-17.6-1-osx-binaries.zip");
        assert_eq!(
            macos.sha256,
            "5afb85f5d764176bb00a527cfc5dd9127b9f8efaa33f5a9afbedbf6ceb985fcc"
        );
        let windows_extension = vector_asset("windows").expect("the Windows extension");
        let macos_extension = vector_asset("macos").expect("the macOS extension");
        assert_eq!(windows_extension.library, "vector.dll");
        assert_eq!(macos_extension.download.file, "pgvector-macos-arm64.zip");
        assert_eq!(
            macos_extension.download.sha256,
            "1486659e0fd58bb4a253a69bc5c8dc3a03f806649cd8172e7ec06b3855d8fa16"
        );
        assert_eq!(macos_extension.library, "vector.dylib");
        // A digest is compared against lower-case hex, so a pin written in any other case would
        // never match what was downloaded.
        for asset in [
            windows,
            macos,
            windows_extension.download,
            macos_extension.download,
        ] {
            assert_eq!(asset.sha256.len(), 64, "{}", asset.file);
            assert!(asset
                .sha256
                .chars()
                .all(|digit| digit.is_ascii_digit() || ('a'..='f').contains(&digit)));
        }
        // A platform this mode does not serve says so, rather than falling back to somebody else's
        // binary: the container route is the one to use there.
        assert!(postgres_asset("linux").is_none());
        assert!(vector_asset("linux").is_none());
        assert!(tree("linux").is_none());
        assert_eq!(supported_here(), cfg!(any(windows, target_os = "macos")));
    }

    /// macOS keeps both folders one level deeper than Windows does, and these functions are what
    /// every other path in this mode is built from — so both rows are asserted on either machine.
    #[test]
    fn both_platforms_have_their_own_folder_shape() {
        let root = Path::new("ccpbot");
        let unpacked = unpacked_folder(root);
        assert_eq!(lib_folder_on(root, "windows"), unpacked.join("lib"));
        assert_eq!(
            extension_folder_on(root, "windows"),
            unpacked.join("share").join("extension")
        );
        assert_eq!(
            lib_folder_on(root, "macos"),
            unpacked.join("lib").join("postgresql")
        );
        assert_eq!(
            extension_folder_on(root, "macos"),
            unpacked.join("share").join("postgresql").join("extension")
        );
        // The machine running this is one of those rows, never a third shape.
        assert_eq!(lib_folder(root), lib_folder_on(root, std::env::consts::OS));
    }

    /// This project's macOS build holds its three files at the top level, not in `lib/` and
    /// `share/extension/`, so placing them cannot assume the Windows shape.
    #[test]
    fn an_extension_that_lies_flat_is_placed_too() {
        let root = scratch("placing-flat");
        let staging = postgres_folder(&root).join(VECTOR_FOLDER);
        std::fs::create_dir_all(&staging).expect("the staging folder");
        std::fs::write(staging.join(vector_library()), "dylib").expect("a library");
        std::fs::write(staging.join(VECTOR_CONTROL), "comment = 'x'").expect("a control file");
        std::fs::write(staging.join("vector--0.8.6.sql"), "-- vector").expect("a script");
        std::fs::write(staging.join("README.md"), "read me").expect("a readme");
        place_vector(&root, &staging).expect("placing the extension");
        assert!(lib_folder(&root).join(vector_library()).is_file());
        assert!(vector_installed(&root));
        assert!(extension_folder(&root).join("vector--0.8.6.sql").is_file());
        assert!(!lib_folder(&root).join("README.md").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The three files are named one at a time, so somebody reading the window learns which part of
    /// the archive went missing rather than that "it failed".
    #[test]
    fn an_extension_without_its_library_says_which_part_is_missing() {
        let root = scratch("placing-incomplete");
        let staging = postgres_folder(&root).join(VECTOR_FOLDER);
        std::fs::create_dir_all(&staging).expect("the staging folder");
        std::fs::write(staging.join(VECTOR_CONTROL), "comment = 'x'").expect("a control file");
        let error = place_vector(&root, &staging).expect_err("no library");
        assert_eq!(error.said, "The unpacked extension has no library in it.");
        std::fs::write(staging.join(vector_library()), "dylib").expect("a library");
        let error = place_vector(&root, &staging).expect_err("no script");
        assert_eq!(
            error.said,
            "The unpacked extension is not laid out the way it is expected to be."
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `pgAdmin 4.app` is most of the macOS archive's expanded size and none of what runs here; the
    /// comparison is per path segment, so everything under it goes with it.
    #[test]
    fn the_application_that_never_runs_is_skipped() {
        assert!(skipped_entry("pgsql/pgAdmin 4.app"));
        assert!(skipped_entry("pgsql/pgAdmin 4.app/Contents/Info.plist"));
        assert!(!skipped_entry("pgsql/bin/postgres"));
        assert!(!skipped_entry(
            "pgsql/share/postgresql/extension/vector.control"
        ));
        assert!(!skipped_entry("pgsql/lib/libicuuc.68.2.dylib"));
    }

    /// Modes measured on the archive itself: the links carry 0o120777, the files 0o100644 and
    /// 0o100755, and a folder 0o040755. Unpacking a link as a file is what stops the server.
    #[test]
    fn a_links_mode_is_what_makes_it_a_link() {
        assert!(is_symlink(0o120777));
        assert!(!is_symlink(0o100644));
        assert!(!is_symlink(0o100755));
        assert!(!is_symlink(0o040755));
    }

    /// A service that started children does not leave them behind: on Unix the signal goes to the
    /// group the service leads, on Windows `taskkill /T` walks the tree. The stand-in here starts a
    /// child of its own that would otherwise live for half a minute.
    #[test]
    fn ending_a_service_ends_what_it_started() {
        #[cfg(unix)]
        let mut command = {
            let mut command = quiet::command("sh");
            command.args(["-c", "sleep 30 & sleep 30"]);
            command
        };
        #[cfg(windows)]
        let mut command = {
            let mut command = quiet::command("cmd");
            command.args(["/c", "ping", "-n", "30", "127.0.0.1"]);
            command
        };
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        // Started the way `start_service` starts one, group included.
        in_its_own_group(&mut command);
        let mut child = command.spawn().expect("a process that waits");
        let pid = child.id();
        end(&mut child);
        assert!(child.try_wait().expect("asking about the child").is_some());
        #[cfg(unix)]
        {
            let group = pid as i32;
            let mut gone = false;
            for _ in 0..40 {
                if unsafe { libc::killpg(group, 0) } == -1 {
                    gone = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            assert!(
                gone,
                "the process group outlived the service it belonged to"
            );
        }
        #[cfg(windows)]
        {
            let listing = quiet::command("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/NH"])
                .output()
                .expect("asking about the process");
            let said = String::from_utf8_lossy(&listing.stdout);
            assert!(
                !said.contains(&pid.to_string()),
                "the process is still listed: {said}"
            );
        }
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

    /// The model screen's answer has to reach the Bot, which on this machine is a process started
    /// with `--env-file=.env`. The credential belongs in this machine's own store — a key is not
    /// written into a file anybody can open — and the settings around it belong in `.env`. Measured
    /// on a published installer, the answer reached neither, and a person who had just answered that
    /// screen was told `OPENAI_API_KEY is not set, and no OPENAI_BASE_URL names an endpoint that needs
    /// no key.`
    #[test]
    fn a_model_choice_reaches_the_store_and_not_the_file() {
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

        assert_eq!(
            crate::vault::recall(&tmp, "OPENAI_API_KEY").expect("the store is readable"),
            Some("sk-from-the-model-screen".to_string())
        );
        let written = std::fs::read_to_string(&file).expect("the file is readable");
        // Not in the file: a key anybody can read is a key anybody can paste into a chat, and the
        // Bot is handed the credential through its environment instead.
        assert!(!written.contains("sk-from-the-model-screen"), "{written}");
        // Every other model key is either emptied in the file (the settings around the credential) or
        // kept out of it (the credentials themselves), so a plan answered in an earlier run cannot be
        // preferred over the key somebody just gave: whichever key a Bot reads first decides who is
        // billed.
        assert!(written.contains("BOT_PROVIDER="), "{written}");
        assert!(!written.contains("ANTHROPIC_API_KEY="), "{written}");
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

    /// A run with nothing to answer with is refused before it starts: the sentence a person reads
    /// names the screen that fixes it, instead of a Bot failure minutes after the download.
    #[test]
    fn a_run_with_nothing_to_answer_with_is_refused_before_it_starts() {
        let empty = scratch("waiting-for-a-model");
        assert!(
            require_a_model(&empty, None).is_err(),
            "an empty folder has no answer to give the Bot"
        );

        // A key in the store is the answer the model screen leaves behind for the next Start.
        crate::vault::remember(&empty, "OPENAI_API_KEY", "sk-answered-earlier")
            .expect("a stored key");
        assert!(require_a_model(&empty, None).is_ok());

        // A key in the file is an answer too, and it is how a keyless endpoint names itself: no
        // credential, only the address it is reached at.
        let typed = scratch("waiting-for-a-model-file");
        std::fs::write(
            typed.join(".env"),
            "OPENAI_BASE_URL=http://127.0.0.1:9/v1\n",
        )
        .expect("a file somebody wrote");
        assert!(require_a_model(&typed, None).is_ok());

        // And the answer that arrives with the request counts before anything has been written.
        let chosen = crate::env::ModelCredential::OpenAi {
            api_key: "sk-from-the-model-screen".to_string(),
        };
        let fresh = scratch("waiting-for-a-model-request");
        assert!(require_a_model(&fresh, Some(&chosen)).is_ok());
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
        // No intelligence connection is written and none is handed in, and that is the point of this
        // test: somebody who installs this and answers nothing but the model screen gets a stack that
        // starts. The assertion below is what keeps the claim honest on a machine whose own `.env`
        // holds a connection — this run would then prove nothing about one that has none.
        let checkout = std::fs::read_to_string(root.join(".env")).unwrap_or_default();
        assert!(
            !checkout.contains("INTELLIGENCE_"),
            "{} already holds an Intelligence connection, so a start on this machine does not show \
             that one is not needed",
            root.join(".env").display()
        );
        // And the model key. The built-in Bot holds a model credential and exits with
        // `OPENAI_API_KEY is not set, and no OPENAI_BASE_URL names an endpoint that needs no key`
        // without one — measured on this machine, not assumed — so the test supplies the placeholder
        // that a person's own key replaces.
        // Through the same path the window uses, rather than a key written here by hand: a local run
        // is handed the model screen's answer, and the credential it implies goes into this machine's
        // own store (a key is not written into a file anybody can open) while the settings around it
        // go into `.env`. The children are handed the store's secret as environment
        // (`hand_the_model_keys`), which is the one place `--env-file` does not override. This
        // placeholder is what makes a local run startable without a person's own key, and it is the
        // exact shape the wizard sends.
        let credential = crate::env::ModelCredential::OpenAi {
            api_key: "sk-local-placeholder-for-a-desktop-run".to_string(),
        };
        let started = start(&root, &cache, None, Some(&credential), |step, detail| {
            println!("[{step}] {detail}");
            steps.push(step.to_string());
        })
        .unwrap_or_else(|problem| {
            panic!(
                "the local stack should start: {problem:?}\n\n{}",
                logs_on_failure(&root)
            )
        });

        // The store, not the file: the Bot answered with this key, and it did so without the key ever
        // being written where anybody can read it.
        let file = std::fs::read_to_string(root.join(".env")).expect("the file is readable");
        assert!(
            !file.contains("sk-local-placeholder-for-a-desktop-run"),
            "{file}"
        );
        assert_eq!(
            crate::vault::recall(&root, "OPENAI_API_KEY").expect("the store is readable"),
            Some("sk-local-placeholder-for-a-desktop-run".to_string())
        );
        // Nothing was invented for it either. A deployment with no CopilotKit account behind it says
        // so on the way up, which it can only do if the server was handed none of the three values.
        assert!(!file.contains("INTELLIGENCE_"), "{file}");
        let server_log =
            std::fs::read_to_string(log_file(&root, "server")).expect("the server log is written");
        assert!(
            server_log.contains("\"intelligence-absent\""),
            "the server log does not say it ran without Intelligence: {}",
            server_log.chars().take(400).collect::<String>()
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

    /// The version the two exams that fetch sources are about, or `None` when there is nothing this
    /// build could fetch.
    ///
    /// `CCPBOT_LIVE_RELEASE=v0.4.0` names one explicitly — an exam that is about a published version
    /// should say which one rather than guess. Otherwise it is this build's own release, and an exam
    /// whose version has no release at all says so in one named line instead of quietly fetching a
    /// different version: what these exams are about is the route in *this* tree, and the latest
    /// release is another tree's sources. A lookup that failed — an anonymous rate limit, an offline
    /// machine — is named with its own text for the same reason: it must not read as "this version
    /// does not exist". The caller asserts that a skip fetched nothing.
    fn version_for_this_exam(exam: &str) -> Option<String> {
        let named = std::env::var("CCPBOT_LIVE_RELEASE")
            .ok()
            .map(|version| version.trim().to_string())
            .filter(|version| !version.is_empty());
        if let Some(named) = named {
            println!("{exam}: fetching {named}, named by CCPBOT_LIVE_RELEASE");
            return Some(named);
        }
        let own = crate::deployment_release::own_tag();
        match crate::deployment_release::own_release_is_published() {
            Ok(true) => Some(own),
            Ok(false) => {
                println!("{exam}: skipped, {own} is not published yet");
                None
            }
            Err(error) => {
                println!("{exam}: skipped, {own} could not be looked up: {error}");
                None
            }
        }
    }

    /// The fetch both of those exams do, for the version they decided on.
    fn fetch_sources(root: &Path, version: &str) -> Result<(), Problem> {
        crate::deployment::fetch(root, version).map_err(|error| {
            Problem::with(format!("CCP-Bot {version} could not be downloaded."), error)
        })
    }

    /// The first run of a machine that has never installed CCP-Bot this way: an empty folder, and
    /// the sources arrive from the release this build's own tag names. This is the difference
    /// between "install and use" and "install, then go and find a checkout", so it is measured
    /// against a real release rather than a stub.
    #[test]
    #[ignore = "downloads the published release from GitHub"]
    fn live_an_empty_folder_is_filled_from_the_release() {
        let root = std::env::temp_dir().join("ccpbot-local-empty-checkout");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("an empty folder");
        assert!(!checkout_ready(&root), "the folder starts empty");

        let exam = "live_an_empty_folder_is_filled_from_the_release";
        let Some(version) = version_for_this_exam(exam) else {
            assert!(!checkout_ready(&root), "a skipped exam fetched nothing");
            return;
        };
        prepare_checkout_with(
            &root,
            &mut |step, detail| println!("[{step}] {detail}"),
            |root| fetch_sources(root, &version),
        )
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
    /// from the release this build's own tag names, and the Bot's own dependencies installed into it
    /// before the Bot is started. That last step is the one a development checkout hides — its
    /// hoisted top level carries an `@ag-ui/encoder` the Bot never declared — so a fresh checkout is
    /// the only place the missing step shows, and building one is what this test is for.
    #[test]
    #[ignore = "downloads the published release and starts real processes"]
    fn live_a_fresh_folder_installs_the_bots_own_dependencies() {
        let root = std::env::temp_dir().join("ccpbot-local-fresh-install");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("an empty folder");
        assert!(!checkout_ready(&root), "the folder starts empty");

        let exam = "live_a_fresh_folder_installs_the_bots_own_dependencies";
        let Some(version) = version_for_this_exam(exam) else {
            assert!(!checkout_ready(&root), "a skipped exam fetched nothing");
            return;
        };
        let cache = std::env::temp_dir().join("ccpbot-local-cache");
        prepare_checkout_with(
            &root,
            &mut |step, detail| println!("[{step}] {detail}"),
            |root| fetch_sources(root, &version),
        )
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
        .unwrap_or_else(|problem| {
            panic!(
                "the local stack should start: {problem:?}\n\n{}",
                logs_on_failure(&root)
            )
        });

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

        let profiles = environment
            .get("PROFILES_DIR")
            .expect("the folder the browsers keep their profiles in");
        assert!(
            profiles.starts_with(&root.join(COMPUTER_FOLDER).display().to_string()),
            "the profiles stay under this deployment, where one Bot's files cannot reach another's: {profiles}"
        );
        assert_ne!(
            profiles, browsers,
            "the browser and the profiles it writes are two folders, not one"
        );

        let _ = std::fs::remove_dir_all(&root);
    }
}
