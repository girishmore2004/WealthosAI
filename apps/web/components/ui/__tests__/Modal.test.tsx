import { fireEvent, render, screen } from "@testing-library/react";
import { Modal } from "../Modal";

describe("Modal", () => {
  it("renders nothing while closed", () => {
    render(
      <Modal open={false} onClose={jest.fn()} title="Hidden">
        <p>content</p>
      </Modal>,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("is an accessible, titled, modal dialog", () => {
    render(
      <Modal open onClose={jest.fn()} title="Quick add">
        <p>content</p>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "Quick add" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("closes on Escape, on the close button and on a backdrop click", () => {
    const onClose = jest.fn();
    render(
      <Modal open onClose={onClose} title="T">
        <input aria-label="field" />
      </Modal>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByLabelText("Close"));
    fireEvent.click(screen.getByTestId("modal-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("moves focus to the first field on open and restores it to the opener on close", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { rerender } = render(
      <Modal open onClose={jest.fn()} title="T">
        <input aria-label="amount" />
        <button>Save</button>
      </Modal>,
    );
    expect(screen.getByLabelText("amount")).toHaveFocus();
    rerender(
      <Modal open={false} onClose={jest.fn()} title="T">
        <input aria-label="amount" />
      </Modal>,
    );
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("keeps Tab inside the dialog (wraps from last to first)", () => {
    render(
      <Modal open onClose={jest.fn()} title="T">
        <input aria-label="first" />
        <button>Last</button>
      </Modal>,
    );
    screen.getByText("Last").focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(screen.getByLabelText("Close")).toHaveFocus();
  });
});
