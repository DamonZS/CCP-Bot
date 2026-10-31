import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { LocalRun, type LocalStatus } from "./LocalRun";

const onStart = mock(() => undefined);
const onStop = mock(() => undefined);

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  onStart.mockClear();
  onStop.mockClear();
  cleanup();
});
afterAll(() => GlobalRegistrator.unregister());

function status(overrides: Partial<LocalStatus> = {}): LocalStatus {
  return {
    supported: true,
    wanted: false,
    database_port: null,
    database_running: false,
    interface_built: false,
    health: null,
    address: "http://127.0.0.1:3010",
    step: "",
    step_detail: "",
    ...overrides,
  };
}

test("local_run_promises_what_a_first_run_will_do", () => {
  const view = render(
    <LocalRun status={null} busy={false} onStart={onStart} onStop={onStop} />,
  );

  // The three things it will bring, and the three things it will not need.
  expect(view.getByText("Portable database")).toBeTruthy();
  expect(view.getByText("Interface")).toBeTruthy();
  expect(view.getByText("Services")).toBeTruthy();
  expect(
    view.getByText("No Docker, no virtual machine, no administrator"),
  ).toBeTruthy();
  expect(view.queryByText("Ready")).toBeNull();
  expect(view.getAllByText("Not yet")).toHaveLength(3);

  fireEvent.click(view.getByRole("button", { name: "Start on this computer" }));
  expect(onStart).toHaveBeenCalledTimes(1);
  expect(onStop).not.toHaveBeenCalled();
  expect(view.queryByRole("button", { name: "Stop CCP-Bot" })).toBeNull();
});

test("local_run_distinguishes_prepared_from_running", () => {
  const view = render(
    <LocalRun
      status={status({
        wanted: true,
        database_port: 63133,
        database_running: false,
        interface_built: true,
      })}
      busy={false}
      onStart={onStart}
      onStop={onStop}
    />,
  );

  // A machine that has run before is not a machine that has never run: the archive is unpacked and
  // the port is remembered, and the screen says so.
  expect(
    view.getByText("Prepared (port 63133). The first run downloads it once."),
  ).toBeTruthy();
  expect(
    view.getByText("Built. The server serves it on the address below."),
  ).toBeTruthy();
  expect(
    view.getByText(
      "The server and the connected agents, as programs on this computer.",
    ),
  ).toBeTruthy();
  expect(view.getByRole("button", { name: "Start on this computer" })).toBeTruthy();
});

test("local_run_shows_the_step_it_is_working_on_and_waits_while_busy", () => {
  const view = render(
    <LocalRun
      status={status({
        wanted: true,
        step: "database",
        step_detail: "Starting the database…",
      })}
      busy={true}
      onStart={onStart}
      onStop={onStop}
    />,
  );

  expect(view.getByText("Database")).toBeTruthy();
  expect(view.getByText("In progress")).toBeTruthy();
  expect(view.getByText("Starting the database…")).toBeTruthy();

  const start = view.getByRole("button", { name: "Starting…" });
  expect(start.hasAttribute("disabled")).toBe(true);
  fireEvent.click(start);
  expect(onStart).not.toHaveBeenCalled();
});

test("local_run_offers_stop_once_it_answers", () => {
  const view = render(
    <LocalRun
      status={status({
        wanted: true,
        database_port: 63133,
        database_running: true,
        interface_built: true,
        health: 200,
      })}
      busy={false}
      onStart={onStart}
      onStop={onStop}
    />,
  );

  expect(view.getByText("Answering on http://127.0.0.1:3010.")).toBeTruthy();
  expect(
    view.getByText("Running on port 63133, on this computer only."),
  ).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Stop CCP-Bot" }));
  expect(onStop).toHaveBeenCalledTimes(1);
});