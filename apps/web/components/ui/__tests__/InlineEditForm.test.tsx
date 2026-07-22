import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InlineEditForm } from "../InlineEditForm";

describe("InlineEditForm", () => {
  it("pre-fills fields from initialValues rather than starting blank", () => {
    render(
      <InlineEditForm
        fields={[{ key: "label", label: "Label" }]}
        initialValues={{ label: "Existing value" }}
        onSave={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    expect(screen.getByDisplayValue("Existing value")).toBeInTheDocument();
  });

  it("calls onSave with the edited values, not the stale initial ones", async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    render(
      <InlineEditForm
        fields={[{ key: "label", label: "Label" }]}
        initialValues={{ label: "Old label" }}
        onSave={onSave}
        onCancel={jest.fn()}
      />,
    );

    fireEvent.change(screen.getByDisplayValue("Old label"), { target: { value: "New label" } });
    fireEvent.click(screen.getByText("Save changes"));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ label: "New label" }));
  });

  it("calls onCancel and does not call onSave when Cancel is clicked", () => {
    const onSave = jest.fn();
    const onCancel = jest.fn();
    render(
      <InlineEditForm
        fields={[{ key: "label", label: "Label" }]}
        initialValues={{ label: "Value" }}
        onSave={onSave}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByText("Cancel"));

    expect(onCancel).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows an error message and re-enables the form when onSave rejects, instead of silently failing", async () => {
    const onSave = jest.fn().mockRejectedValue(new Error("Could not save changes."));
    render(
      <InlineEditForm
        fields={[{ key: "label", label: "Label" }]}
        initialValues={{ label: "Value" }}
        onSave={onSave}
        onCancel={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Save changes"));

    expect(await screen.findByText("Could not save changes.")).toBeInTheDocument();
    expect(screen.getByText("Save changes")).not.toBeDisabled();
  });

  it("renders a select field with the provided options and reflects the initial value", () => {
    render(
      <InlineEditForm
        fields={[{ key: "type", label: "Type", type: "select", options: [{ value: "A", label: "Option A" }, { value: "B", label: "Option B" }] }]}
        initialValues={{ type: "B" }}
        onSave={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    expect(screen.getByRole("combobox")).toHaveValue("B");
  });

  it("renders a checkbox field reflecting a boolean initial value", () => {
    render(
      <InlineEditForm
        fields={[{ key: "isRented", label: "Rented", type: "checkbox" }]}
        initialValues={{ isRented: true }}
        onSave={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    expect(screen.getByRole("checkbox")).toBeChecked();
  });
});
