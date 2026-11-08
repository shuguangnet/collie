import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, useLoaderData } from "react-router";
import { http, HttpResponse } from "msw";
import { server } from "@/test/setup";
import { MachineProfiles } from "./machine-profiles";
import type { MachineProfilesDocument } from "@/lib/types";

const saved: MachineProfilesDocument = { version: 1, muxes: ["herdr"], profiles: [{ id: "a".repeat(24), name: "Work", sshHost: "pat@work", mux: "herdr", port: 8787, leadAddress: "", peerAddress: "", remotePath: "", instance: "", createdAt: 1 }] };
function mount(doc: MachineProfilesDocument | null = { version: 1, profiles: [], muxes: ["herdr"] }, readOnly = false, failed = false) {
  let current = doc;
  function View() {
    const data = useLoaderData<MachineProfilesDocument | null>();
    return <MachineProfiles document={data} failed={failed} readOnly={readOnly} />;
  }
  const router = createMemoryRouter([{ path: "/", loader: () => current, Component: View }]);
  render(<RouterProvider router={router} />);
  return { router, set: (next: MachineProfilesDocument) => { current = next; } };
}
describe("server-owned machine connection profiles", () => {
  it("says save is not connection proof and gives an id-only terminal command", async () => {
    mount(saved);
    expect(await screen.findByText("Work")).toBeInTheDocument();
    expect(screen.getByText("Saved · not a connection check")).toBeInTheDocument();
    expect(screen.getByText(`collie crew add --saved ${"a".repeat(24)}`)).toBeInTheDocument();
    expect(screen.getByText(/Saving does not connect or install anything/)).toBeInTheDocument();
    expect(screen.queryByText(/password/i, { selector: "input" })).not.toBeInTheDocument();
  });
  it("saves through the bridge, revalidates server data, and never writes browser storage", async () => {
    const user = userEvent.setup(); let body: unknown;
    const m = mount();
    server.use(http.post("*/api/machine-profiles", async ({ request }) => { body = await request.json(); m.set(saved); return HttpResponse.json(saved, { status: 201 }); }));
    const before = { ...localStorage }; const sessionBefore = { ...sessionStorage };
    await user.click(await screen.findByRole("button", { name: "Add machine connection" }));
    await user.type(screen.getByLabelText("Machine name"), "Work");
    await user.type(screen.getByLabelText("SSH destination"), "pat@work");
    expect(screen.getByText(/127.0.0.1 only means itself/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save on server" }));
    expect(await screen.findByText("Work")).toBeInTheDocument();
    expect(body).toEqual({ name: "Work", sshHost: "pat@work", port: 8787, mux: "herdr", leadAddress: "", peerAddress: "", remotePath: "", instance: "" });
    expect({ ...localStorage }).toEqual(before); expect({ ...sessionStorage }).toEqual(sessionBefore);
  });
  it("write failure keeps the form, does not invent a saved record", async () => {
    const user = userEvent.setup(); mount();
    server.use(http.post("*/api/machine-profiles", () => HttpResponse.json({ error: "unavailable" }, { status: 503 })));
    await user.click(await screen.findByRole("button", { name: "Add machine connection" }));
    await user.type(screen.getByLabelText("Machine name"), "Work"); await user.type(screen.getByLabelText("SSH destination"), "work");
    await user.click(screen.getByRole("button", { name: "Save on server" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not read or save");
    expect(screen.getByLabelText("Machine name")).toHaveValue("Work");
    expect(screen.queryByText("Saved · not a connection check")).not.toBeInTheDocument();
  });
  it("duplicate is actionable; read failures do not offer to overwrite the server store", async () => {
    const user = userEvent.setup(); mount();
    server.use(http.post("*/api/machine-profiles", () => HttpResponse.json({ error: "duplicate" }, { status: 409 })));
    await user.click(await screen.findByRole("button", { name: "Add machine connection" }));
    await user.type(screen.getByLabelText("Machine name"), "Work"); await user.type(screen.getByLabelText("SSH destination"), "work");
    await user.click(screen.getByRole("button", { name: "Save on server" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already has that name");
  });
  it("removal requires a second deliberate tap and leaves Crew membership alone", async () => {
    const user = userEvent.setup(); const m = mount(saved); let id: unknown;
    server.use(http.delete("*/api/machine-profiles", async ({ request }) => { id = await request.json(); const empty: MachineProfilesDocument = { version: 1, profiles: [] }; m.set(empty); return HttpResponse.json(empty); }));
    await user.click(await screen.findByRole("button", { name: "Remove saved profile" }));
    expect(id).toBeUndefined(); expect(screen.getByText(/Joined Crew membership and running services will not change/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Remove profile$/ }));
    await screen.findByText("No connection profiles saved yet."); expect(id).toEqual({ id: "a".repeat(24) });
  });
  it("read-only devices can see saved profiles but cannot add or remove", async () => {
    mount(saved, true); await screen.findByText("Work");
    expect(screen.queryByRole("button", { name: /Add machine|Remove saved/ })).not.toBeInTheDocument();
  });
  it("a damaged store is not presented as an empty editable list", async () => {
    mount(null, false, true); expect(await screen.findByRole("alert")).toHaveTextContent("Could not read");
    expect(screen.queryByText("No connection profiles saved yet.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add machine connection" })).not.toBeInTheDocument();
  });
});
