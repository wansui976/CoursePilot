import "@testing-library/jest-dom/vitest";
import i18n from "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toLocalDate, useCourseExams } from "@/lib/exams";
import { ExamCountdown, ExamDialog } from "./ExamDialog";

const course = { id: "c1", name: "高等数学" };
const inDays = (days: number) => toLocalDate(Date.now() + days * 86_400_000);

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  localStorage.clear();
  useCourseExams.setState({ exams: {} });
});

describe("ExamDialog", () => {
  it("saves a named exam date", () => {
    const onClose = vi.fn();
    render(<ExamDialog course={course} onClose={onClose} />);
    const save = screen.getByRole("button", { name: "保存" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "期末考试" } });
    fireEvent.change(screen.getByLabelText("日期"), { target: { value: inDays(10) } });
    expect(screen.getByText("还有 10 天")).toBeInTheDocument();
    fireEvent.click(save);
    expect(useCourseExams.getState().exams.c1).toEqual({ name: "期末考试", date: inDays(10) });
    expect(onClose).toHaveBeenCalled();
  });

  it("clears a saved exam", () => {
    useCourseExams.getState().setExam("c1", { name: "期中", date: inDays(3) });
    render(<ExamDialog course={course} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "清除" }));
    expect(useCourseExams.getState().exams.c1).toBeUndefined();
  });
});

describe("ExamCountdown", () => {
  it("counts down and suggests a daily pace", () => {
    useCourseExams.getState().setExam("c1", { name: "期末考试", date: inDays(11) });
    const onEdit = vi.fn();
    render(<ExamCountdown courseId="c1" total={30} watched={10} onEdit={onEdit} />);
    const button = screen.getByRole("button", { name: /距期末考试 11 天/ });
    expect(button).toHaveTextContent("每天约 2 讲");
    fireEvent.click(button);
    expect(onEdit).toHaveBeenCalled();
  });

  it("renders nothing without an upcoming exam", () => {
    const { container } = render(<ExamCountdown courseId="c1" total={3} watched={0} onEdit={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
