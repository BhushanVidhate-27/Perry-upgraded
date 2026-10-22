"use client";

import { useState } from "react";
import { useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import { useNow } from "@/lib/format";
import { useSession } from "@/lib/session";
import { QuickAdd, StreakBadge, TodoEditDialog, TodoRows } from "@/components/todos/todos";
import type { TodoView } from "@/convex/todos";
import { Button } from "@/components/ui/button";
import { EmptyState, ListSkeleton, Page, Section } from "../common";

/**
 * Your own to-do list, the one the desktop pet keeps on screen. What Perry
 * adds from a chat shows up here too, marked with a sparkle.
 */
export function Todos() {
  const { dashboardKey } = useSession();
  const board = useQuery(api.todos.board, { key: dashboardKey });
  const now = useNow(15_000);
  const [filter, setFilter] = useState<"all" | "today" | "overdue" | "completed">("all");
  const [editing, setEditing] = useState<TodoView | null>(null);
  const open = board?.open ?? [];
  const completed = board?.doneRecent ?? [];
  const visible = filter === "completed" ? completed : open.filter((todo) => {
    if (filter === "overdue") return todo.dueAt !== undefined && todo.dueAt <= now;
    if (filter === "today") {
      if (todo.dueAt === undefined) return false;
      const day = new Date(todo.dueAt); const current = new Date(now);
      return day.getFullYear() === current.getFullYear() && day.getMonth() === current.getMonth() && day.getDate() === current.getDate();
    }
    return true;
  });
  const filters = [
    ["all", "Open", open.length], ["today", "Today", open.filter((todo) => todo.dueAt !== undefined && new Date(todo.dueAt).toDateString() === new Date(now).toDateString()).length],
    ["overdue", "Overdue", open.filter((todo) => todo.dueAt !== undefined && todo.dueAt <= now).length], ["completed", "Completed", completed.length],
  ] as const;

  return (
    <Page
      title="To-dos"
      description="Timed ones remind you on screen, or on your phone when you're away."
      actions={board ? <StreakBadge days={board.streak} /> : undefined}
    >
      <QuickAdd className="mb-6" />
      <div className="mb-4 flex flex-wrap gap-1" role="group" aria-label="Filter to-dos">
        {filters.map(([value, label, count]) => <Button key={value} type="button" size="sm" variant={filter === value ? "secondary" : "ghost"} aria-pressed={filter === value} onClick={() => setFilter(value)}>
          {label}<span className="nums text-xs text-muted-foreground">{count}</span>
        </Button>)}
      </div>
      {board === undefined ? <ListSkeleton />
        : visible.length === 0 ? <EmptyState title={filter === "completed" ? "Nothing completed recently" : filter === "overdue" ? "Nothing overdue" : "Nothing to do"} mascot />
        : <div className="-mx-2"><TodoRows todos={visible} now={now} onEdit={filter === "completed" ? undefined : setEditing} /></div>}
      {board && filter === "all" && board.doneToday.length > 0 && (
        <Section title="Done today" className="mt-8">
          <div className="-mx-2"><TodoRows todos={board.doneToday} now={now} /></div>
        </Section>
      )}
      {board && filter === "all" && board.doneRecent.filter((todo) => !board.doneToday.some((today) => today.id === todo.id)).length > 0 && (
        <Section title="Completed recently" className="mt-8">
          <div className="-mx-2"><TodoRows todos={board.doneRecent.filter((todo) => !board.doneToday.some((today) => today.id === todo.id))} now={now} /></div>
        </Section>
      )}
      <TodoEditDialog todo={editing} onClose={() => setEditing(null)} />
    </Page>
  );
}
