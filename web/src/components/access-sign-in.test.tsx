import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "@/test/setup";
import { AccessSignIn } from "./access-sign-in";
import { getDeviceToken, setDeviceToken } from "@/lib/pairing";

const { revalidate } = vi.hoisted(() => ({ revalidate: vi.fn() }));
vi.mock("react-router", () => ({
  useRevalidator: () => ({ revalidate }),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));
beforeEach(() => {
  revalidate.mockClear();
  server.use(http.get("/api/auth/status", () => HttpResponse.json({ configured: true })));
});

describe("fixed password sign-in", () => {
  test("stores only the device token, clears password and revalidates", async () => {
    const user = userEvent.setup();
    const token = "a".repeat(43);
    let sent: unknown;
    server.use(http.post("/api/auth/login", async ({ request }) => {
      sent = await request.json();
      return HttpResponse.json({ token, label: "Laptop" });
    }));
    render(<AccessSignIn />);
    await user.type(await screen.findByLabelText("Name for this device"), "Laptop");
    await user.type(screen.getByLabelText("Access password"), "a-private-passphrase");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(getDeviceToken()).toBe(token));
    expect(sent).toEqual({ label: "Laptop", password: "a-private-passphrase" });
    expect(screen.getByLabelText("Access password")).toHaveValue("");
    expect(JSON.stringify(localStorage)).not.toContain("a-private-passphrase");
    expect(revalidate).toHaveBeenCalled();
  });

  test("wrong passwords keep the device token unchanged and do not revalidate", async () => {
    const user = userEvent.setup();
    setDeviceToken("held-token");
    server.use(http.post("/api/auth/login", () => HttpResponse.json({ code: "auth.password_incorrect" }, { status: 401 })));
    render(<AccessSignIn />);
    await user.type(await screen.findByLabelText("Name for this device"), "Laptop");
    await user.type(screen.getByLabelText("Access password"), "wrong-passphrase");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("incorrect");
    expect(getDeviceToken()).toBe("held-token");
    expect(revalidate).not.toHaveBeenCalled();
  });

  test("unconfigured hosts offer CLI setup, local open and the existing code flow", async () => {
    server.use(http.get("/api/auth/status", () => HttpResponse.json({ configured: false })));
    const user = userEvent.setup();
    render(<AccessSignIn />);
    expect(await screen.findByText("collie password set")).toBeInTheDocument();
    expect(screen.getByText("collie open")).toBeInTheDocument();
    expect(screen.queryByLabelText("Access password")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use a pairing code instead" }));
    expect(screen.getByLabelText("Pairing code")).toBeInTheDocument();
  });

  test("503 is unavailable, not an invitation to set a password or wipe a credential", async () => {
    setDeviceToken("still-held");
    server.use(http.get("/api/auth/status", () => new HttpResponse(null, { status: 503 })));
    render(<AccessSignIn />);
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByText("collie password set")).not.toBeInTheDocument();
    expect(getDeviceToken()).toBe("still-held");
  });
});
