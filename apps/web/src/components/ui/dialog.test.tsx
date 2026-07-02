// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogIcon,
} from "./dialog";

function open(children: React.ReactNode) {
  return render(
    <Dialog open onOpenChange={() => {}}>
      <DialogContent>{children}</DialogContent>
    </Dialog>,
  );
}

describe("DialogHeader", () => {
  it("renders a close button by default", () => {
    open(
      <>
        <DialogHeader>
          <DialogTitle>Hi</DialogTitle>
        </DialogHeader>
        <DialogBody>body</DialogBody>
      </>,
    );
    expect(screen.getByRole("button", { name: /close/i })).toBeInTheDocument();
  });

  it("hides the close button when showClose is false", () => {
    open(
      <DialogHeader showClose={false}>
        <DialogTitle>Hi</DialogTitle>
      </DialogHeader>,
    );
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
  });
});

describe("DialogBody", () => {
  it("renders its children", () => {
    open(<DialogBody>hello body</DialogBody>);
    expect(screen.getByText("hello body")).toBeInTheDocument();
  });
});

describe("DialogIcon", () => {
  it("renders its children", () => {
    open(
      <DialogHeader>
        <DialogIcon>
          <svg data-testid="ic" />
        </DialogIcon>
        <DialogTitle>Hi</DialogTitle>
      </DialogHeader>,
    );
    expect(screen.getByTestId("ic")).toBeInTheDocument();
  });
});
