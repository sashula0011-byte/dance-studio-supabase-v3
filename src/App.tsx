import React, { useMemo, useRef, useState, useEffect } from "react";
import { Plus, Calendar as CalendarIcon, Clock3, Save, X, Eye, ArrowLeft, ChevronDown } from "lucide-react";
import { supabase } from "./lib/supabase";

/**
 * Танцевальная студия — бронирование залов (тёмная тема)
 * - Добавление: шкала 07:00–24:00, drag/resize с шагом 10 мин, панель деталей:
 *   • Desktop — «прилипает» к черновику сбоку
 *   • Mobile — нижний шит (bottom-sheet) + можно свернуть в кнопку «Детали»
 * - Тап ≠ скролл: черновик создаётся ТОЛЬКО при коротком тапе без сдвига (>6px = прокрутка, не создаём)
 * - Обзор: список броней по залам с двухшаговым удалением.
 * - Хранилище: Supabase (если настроен .env) или localStorage (fallback).
 *
 * 2025-08-15 — mobile fix: клики по панели не создают черновик
 *   • добавлен data-kind="panel" для мобильного шита и кнопки «Детали»
 *   • onPointer*Capture со stopPropagation на шите (mobile)
 *   • дополнительные проверки в onCanvasPointerDown/Up на попадание в панель
 */

const ROOMS = ["Белый", "Серый", "Черный"] as const;
const TEACHERS = ["Саша", "Яна", "Гриша", "Соня", "Вика", "Даша", "Ника", "Богдан"] as const;
const TYPES = ["Группа", "Индива", "Педагог"] as const;

type Room = typeof ROOMS[number];
type Teacher = typeof TEACHERS[number];
type LessonType = typeof TYPES[number];

const START_MIN = 7 * 60; // 07:00
const END_MIN = 24 * 60;  // 24:00
const DAY_MIN = END_MIN - START_MIN;
const PX_PER_MIN = 2;
const SNAP = 10;              // шаг 10 минут
const DEFAULT_DURATION = 60;  // 60 минут
const MIN_DURATION = 15;      // минимальная длительность

interface Booking {
  id: string;
  date: string;
  room: Room;
  start: number;
  end: number;
  teacher: Teacher;
  type: LessonType;
  note?: string;
}

interface Draft extends Omit<Booking, "id" | "teacher" | "type"> {
  teacher?: Teacher;
  type?: LessonType;
  id?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const m2hm = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const snapToStep = (mins: number, step = SNAP) => Math.round(mins / step) * step;
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const genId = () => Math.random().toString(36).slice(2, 9);
const overlaps = (aS:number,aE:number,bS:number,bE:number) => aS < bE && aE > bS;

function dateTodayString() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Store: Supabase (если доступен) или localStorage
function useBookingsStore() {
  const remote = !!supabase;
  const [items, setItems] = useState<Booking[]>(() => {
    if (remote) return [];
    try { const raw = localStorage.getItem("dance_bookings_v1"); if (raw) return JSON.parse(raw); } catch {}
    return [];
  });
  const [loading, setLoading] = useState<boolean>(remote);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (remote) return;
    try { localStorage.setItem("dance_bookings_v1", JSON.stringify(items)); } catch {}
  }, [items]);

  // Realtime
  useEffect(() => {
    if (!remote || !supabase) return;
    const sb = supabase!;
    const ch = sb
      .channel("bookings")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "bookings" }, (p: any) =>
        setItems(prev => [...prev, p.new as Booking]))
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "bookings" }, (p: any) =>
        setItems(prev => prev.map(x => x.id === p.new.id ? (p.new as Booking) : x)))
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "bookings" }, (p: any) =>
        setItems(prev => prev.filter(x => x.id !== p.old.id)))
      .subscribe();
    return () => { try { sb.removeChannel(ch); } catch {} };
  }, [remote]);

  async function loadDay(date?: string) {
    if (!remote || !supabase) return;
    const sb = supabase!;
    setLoading(true); setError(null);
    try {
      let q = sb.from("bookings").select("*").order("start", { ascending: true });
      if (date) q = q.eq("date", date);
      const { data, error } = await q;
      if (error) throw error;
      setItems((data ?? []) as Booking[]);
    } catch (e:any) {
      setError(e?.message || String(e));
    } finally { setLoading(false); }
  }

  async function add(b: Booking) {
    if (!remote || !supabase) { setItems(prev => [...prev, b]); return; }
    const sb = supabase!;
    const { error, data } = await sb.from("bookings").insert(b).select().single();
    if (error) throw error;
    setItems(prev => [...prev, data as Booking]);
  }

  async function remove(id: string) {
    if (!remote || !supabase) { setItems(prev => prev.filter(x => x.id !== id)); return; }
    const sb = supabase!;
    const { error } = await sb.from("bookings").delete().eq("id", id);
    if (error) throw error;
    setItems(prev => prev.filter(x => x.id !== id));
  }

  return { items, setItems, loading, error, remote, loadDay, add, remove } as const;
}

export default function App() {
  const [route, setRoute] = useState<"home" | "add" | "overview">("home");
  const [date, setDate] = useState<string>(dateTodayString());
  const [room, setRoom] = useState<Room>("Белый");
  const { items: bookings, loading, error, remote, loadDay, add, remove } = useBookingsStore();

  useEffect(() => { loadDay(date); }, [date]);

  return (
    <div className="min-h-screen bg-neutral-900 text-neutral-100 antialiased">
      <header className="sticky top-0 z-30 border-b border-neutral-800/80 bg-neutral-900/80 backdrop-blur supports-[backdrop-filter]:bg-neutral-900/60">
        <div className="mx-auto max-w-6xl px-4 py-3 flex items-center gap-3">
          {route !== "home" && (
            <button
              onClick={() => setRoute("home")}
              className="inline-flex items-center gap-2 rounded-xl border border-neutral-700/60 px-3 py-2 text-sm hover:bg-neutral-800 active:scale-[.99]"
            >
              <ArrowLeft className="h-4 w-4" />
              Назад
            </button>
          )}
          <div className="ml-auto flex items-center gap-3 text-sm opacity-80">
            <span className="inline-flex items-center gap-2"><Clock3 className="h-4 w-4" /> 07:00–24:00 | шаг 10 мин</span>
            <span className={`rounded-md border px-2 py-0.5 text-xs ${remote ? "border-emerald-600/40 text-emerald-300" : "border-neutral-600/40 text-neutral-300"}`}>
              {remote ? "Supabase" : "Local"}
            </span>
          </div>
        </div>
        {error && <div className="mx-auto max-w-6xl px-4 pb-3 text-xs text-rose-400">Ошибка: {error}</div>}
      </header>

      {route === "home" && <HomeScreen onAdd={() => setRoute("add")} onOverview={() => setRoute("overview")} />}

      {route === "add" && (
        <AddScreen
          date={date} setDate={setDate} room={room} setRoom={setRoom}
          bookings={bookings}
          onSaveBooking={async (b) => add(b)}
        />
      )}

      {route === "overview" && (
        <OverviewScreen date={date} setDate={setDate} bookings={bookings} onDelete={async (id) => remove(id)} />
      )}

      <footer className="border-t border-neutral-800/80">
        <div className="mx-auto max-w-6xl px-4 py-4 text-xs text-neutral-400 flex items-center justify-between">
          <span>Студия танцев · бронирование залов</span>
          <span>{remote ? "Общий календарь (Supabase)" : "Локальный режим"}</span>
        </div>
      </footer>
    </div>
  );
}

function HomeScreen({ onAdd, onOverview }: { onAdd: () => void; onOverview: () => void }) {
  return (
    <main className="mx-auto max-w-6xl px-4 py-12">
      <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Панель студии</h1>
      <p className="mt-2 text-neutral-400">Быстрое добавление занятий и обзор занятости залов.</p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <PrimaryCard title="Добавить занятие" icon={<Plus className="h-6 w-6" />} onClick={onAdd} description="Перейти к бронированию выбранного зала на шкале времени." />
        <PrimaryCard title="Занятость залов" icon={<Eye className="h-6 w-6" />} onClick={onOverview} description="Открыть календарь с текущей занятостью по каждому залу." />
      </div>
    </main>
  );
}

function PrimaryCard({ title, description, icon, onClick }: { title: string; description: string; icon: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="group relative overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900/60 p-6 text-left transition hover:border-neutral-700 hover:bg-neutral-800/60 active:scale-[.995]">
      <div className="flex items-center justify-between">
        <div className="text-lg font-medium">{title}</div>
        <div className="rounded-xl border border-neutral-700/60 bg-neutral-800/60 p-3">{icon}</div>
      </div>
      <p className="mt-3 text-sm text-neutral-400">{description}</p>
    </button>
  );
}

// --- Экран «Добавить занятие» ---
function AddScreen({
  date, setDate, room, setRoom, bookings, onSaveBooking,
}: {
  date: string; setDate: (v: string) => void;
  room: Room; setRoom: (r: Room) => void;
  bookings: Booking[]; onSaveBooking: (b: Booking) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [form, setForm] = useState<{ teacher?: Teacher; type?: LessonType; note?: string }>({});
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const isInsidePanel = (el: EventTarget | null) => !!(el as HTMLElement | null)?.closest?.('[data-kind="panel"]');

  // --- TAP vs SCROLL: создаём черновик только при коротком тапе без сдвига
  const tapRef = useRef<{ startX:number; startY:number; moved:boolean } | null>(null);
  function onCanvasPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // игнорим тапы по панели/её дочерним элементам (включая мобильный шит)
    if (isInsidePanel(e.target)) return;
    if ((e as any).button !== undefined && (e as any).button !== 0) return; // только primary button для мыши
    tapRef.current = { startX: e.clientX, startY: e.clientY, moved: false };
  }
  function onCanvasPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!tapRef.current) return;
    const dx = Math.abs(e.clientX - tapRef.current.startX);
    const dy = Math.abs(e.clientY - tapRef.current.startY);
    if (dx > 6 || dy > 6) tapRef.current.moved = true; // скролл/перетаскивание
  }
  function onCanvasPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!tapRef.current || tapRef.current.moved) { tapRef.current = null; return; }
    // если палец/клик отпустили на панели — не создавать черновик
    if (isInsidePanel(e.target)) { tapRef.current = null; return; }
    const cont = scrollRef.current!;
    const rect = cont.getBoundingClientRect();
    const y = e.clientY - rect.top + cont.scrollTop;
    const minutesFromStart = START_MIN + y / PX_PER_MIN;
    const start = clamp(snapToStep(minutesFromStart), START_MIN, END_MIN - MIN_DURATION);
    const end = clamp(start + DEFAULT_DURATION, start + MIN_DURATION, END_MIN);
    setDraft({ id: `draft-${genId()}`, date, room, start, end });
    setForm({});
    tapRef.current = null;
  }

  const dayRoomBookings = useMemo(
    () => bookings.filter((b) => b.date === date && b.room === room).sort((a, b) => a.start - b.start),
    [bookings, date, room]
  );

  // автопрокрутка к черновику (чтобы он и панель были в зоне видимости)
  useEffect(() => {
    if (!draft || !scrollRef.current) return;
    const top = (draft.start - START_MIN) * PX_PER_MIN;
    const bottom = (draft.end - START_MIN) * PX_PER_MIN;
    const viewTop = scrollRef.current.scrollTop;
    const viewBottom = viewTop + scrollRef.current.clientHeight;
    const pad = 80;
    let newScroll = viewTop;
    if (top - pad < viewTop) newScroll = Math.max(0, top - pad);
    if (bottom + pad > viewBottom) newScroll = bottom + pad - scrollRef.current.clientHeight;
    if (newScroll !== viewTop) scrollRef.current.scrollTo({ top: newScroll, behavior: "smooth" });
  }, [draft]);

  const isDraftValid = useMemo(() => {
    if (!draft) return false;
    const duration = draft.end - draft.start;
    if (duration < MIN_DURATION) return false;
    for (const b of dayRoomBookings) if (overlaps(draft.start, draft.end, b.start, b.end)) return false;
    return true;
  }, [draft, dayRoomBookings]);

  async function saveDraft() {
    if (!draft || !isDraftValid || !form.teacher || !form.type) return;
    const booking: Booking = {
      id: (crypto as any)?.randomUUID?.() ?? genId(),
      date: draft.date,
      room: draft.room,
      start: draft.start,
      end: draft.end,
      teacher: form.teacher,
      type: form.type,
      note: form.note?.trim() || undefined,
    };
    await onSaveBooking(booking);
    setDraft(null);
    setForm({});
  }
  function cancelDraft() { setDraft(null); setForm({}); }

  type DragMode = null | "move" | "resize-top" | "resize-bottom";
  const dragState = useRef<{ mode: DragMode; startY: number; startStart: number; startEnd: number } | null>(null);

  function onDraftPointerDown(e: React.PointerEvent, mode: DragMode) {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragState.current = { mode, startY: e.clientY, startStart: draft!.start, startEnd: draft!.end };
  }
  function onDraftPointerMove(e: React.PointerEvent) {
    if (!dragState.current || !draft) return;
    const dy = e.clientY - dragState.current.startY;
    const dmin = Math.round(dy / PX_PER_MIN);
    const { mode, startStart, startEnd } = dragState.current;
    if (mode === "move") {
      let newStart = snapToStep(startStart + dmin);
      let duration = startEnd - startStart;
      newStart = clamp(newStart, START_MIN, END_MIN - duration);
      const newEnd = newStart + duration;
      setDraft({ ...draft, start: newStart, end: newEnd });
    } else if (mode === "resize-top") {
      let newStart = snapToStep(startStart + dmin);
      newStart = clamp(newStart, START_MIN, startEnd - MIN_DURATION);
      setDraft({ ...draft, start: newStart });
    } else if (mode === "resize-bottom") {
      let newEnd = snapToStep(startEnd + dmin);
      newEnd = clamp(newEnd, draft.start + MIN_DURATION, END_MIN);
      setDraft({ ...draft, end: newEnd });
    }
  }
  function onDraftPointerUp(e: React.PointerEvent) {
    if (dragState.current) {
      try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
      dragState.current = null;
    }
  }

  const columnHeight = DAY_MIN * PX_PER_MIN;

  return (
    <main className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <LabeledField label="Дата">
          <div className="relative">
            <CalendarIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-500" />
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full rounded-xl border border-neutral-700 bg-neutral-800/80 px-9 py-2 text-sm outline-none ring-0 focus:border-neutral-600" />
          </div>
        </LabeledField>
        <LabeledField label="Зал">
          <div className="relative">
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-500" />
            <select value={room} onChange={(e) => setRoom(e.target.value as Room)} className="w-full appearance-none rounded-xl border border-neutral-700 bg-neutral-800/80 px-3 py-2 pr-9 text-sm outline-none focus:border-neutral-600">
              {ROOMS.map((r) => (<option key={r} value={r}>{r}</option>))}
            </select>
          </div>
        </LabeledField>
        <div className="flex items-end"><div className="text-xs text-neutral-500">В режиме добавления показывается только выбранный зал.</div></div>
      </div>

      <div className="relative rounded-2xl border border-neutral-800 bg-neutral-900/60">
        <div className="grid grid-cols-[72px_1fr] border-b border-neutral-800">
          <div className="px-2 py-2 text-xs text-neutral-500">Время</div>
          <div className="flex items-center justify-between px-3 py-2 text-sm text-neutral-300">
            <div className="font-medium">Зал: {room}</div>
            <div className="text-neutral-500">Клик/тап — черновик на 60 минут. Перетягивайте для коррекции.</div>
          </div>
        </div>

        <div
          ref={scrollRef}
          className="relative h-[62vh] overflow-y-auto"
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={onCanvasPointerUp}
        >
          <div className="grid grid-cols-[72px_1fr]" style={{ height: columnHeight }}>
            {/* Левая колонка времени с пунктирной сеткой */}
            <div className="relative border-r border-neutral-800" style={{ backgroundImage: "repeating-linear-gradient(to bottom, rgba(255,255,255,0.06) 0, rgba(255,255,255,0.06) 1px, transparent 1px, transparent 20px)" }}>
              {Array.from({ length: (END_MIN - START_MIN) / 60 + 1 }).map((_, i) => {
                const hm = START_MIN + i * 60;
                const top = (hm - START_MIN) * PX_PER_MIN;
                return (
                  <div key={i} className="absolute left-0 right-0" style={{ top }}>
                    <div className="border-t border-dashed border-neutral-700/70" />
                    <div className="absolute left-0 right-0 -translate-y-1/2">
                      <div className="flex items-center gap-2 px-2">
                        <div className="w-12 text-right text-xs text-neutral-400 tabular-nums">{m2hm(hm)}</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Колонка зала с такой же сеткой */}
            <div className="relative" style={{ backgroundImage: "repeating-linear-gradient(to bottom, rgba(255,255,255,0.06) 0, rgba(255,255,255,0.06) 1px, transparent 1px, transparent 20px)" }}>
              {Array.from({ length: (END_MIN - START_MIN) / 60 + 1 }).map((_, i) => {
                const hm = START_MIN + i * 60;
                const top = (hm - START_MIN) * PX_PER_MIN;
                return (<div key={i} className="absolute left-0 right-0" style={{ top }}><div className="border-t border-dashed border-neutral-700/70" /></div>);
              })}

              {/* Сохранённые брони */}
              {dayRoomBookings.map((b) => (<Block key={b.id} booking={b} />))}

              {/* Черновик */}
              {draft && (
                <DraftBlock
                  draft={draft}
                  valid={isDraftValid}
                  onPointerDown={onDraftPointerDown}
                  onPointerMove={onDraftPointerMove}
                  onPointerUp={onDraftPointerUp}
                  gridRef={scrollRef}
                  form={form}
                  setForm={setForm}
                  onSave={saveDraft}
                  onCancel={cancelDraft}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

function LabeledField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-xs uppercase tracking-wide text-neutral-400">{label}</div>
      {children}
    </label>
  );
}

function Block({ booking }: { booking: Booking }) {
  const top = (booking.start - START_MIN) * PX_PER_MIN;
  const height = (booking.end - booking.start) * PX_PER_MIN;
  return (
    <div
      data-kind="block"
      className="pointer-events-none absolute left-3 right-3 rounded-lg border border-emerald-500/30 bg-emerald-500/15 px-3 py-2 text-sm"
      style={{ top, height }}
      title={`${booking.room} • ${m2hm(booking.start)}–${m2hm(booking.end)} • ${booking.teacher} • ${booking.type}${booking.note ? " — " + booking.note : ""}`}
    >
      <div className="flex items-center justify-between text-emerald-200/90">
        <div className="font-medium">{m2hm(booking.start)}–{m2hm(booking.end)}</div>
        <div className="text-xs">{booking.type}</div>
      </div>
      <div className="mt-1 text-xs text-emerald-100/80">{booking.teacher}{booking.note ? ` · ${booking.note}` : ""}</div>
    </div>
  );
}

function DraftBlock({
  draft, valid, onPointerDown, onPointerMove, onPointerUp, gridRef, form, setForm, onSave, onCancel,
}: {
  draft: Draft;
  valid: boolean;
  onPointerDown: (e: React.PointerEvent, mode: "move" | "resize-top" | "resize-bottom") => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  gridRef: React.RefObject<HTMLDivElement>;
  form: { teacher?: Teacher; type?: LessonType; note?: string };
  setForm: React.Dispatch<React.SetStateAction<{ teacher?: Teacher; type?: LessonType; note?: string }>>;
  onSave: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const top = (draft.start - START_MIN) * PX_PER_MIN;
  const height = (draft.end - draft.start) * PX_PER_MIN;

  // -------- mobile detection --------
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const cb = () => setIsMobile(mq.matches);
    cb(); mq.addEventListener("change", cb);
    return () => mq.removeEventListener("change", cb);
  }, []);

  // -------- desktop positioning (как было) --------
  const [panelTop, setPanelTop] = useState<number>(0);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const handler = () => setScrollTop(el.scrollTop);
    handler();
    el.addEventListener("scroll", handler, { passive: true } as any);
    return () => el.removeEventListener("scroll", handler as any);
  }, [gridRef]);

  useEffect(() => {
    if (isMobile) return; // для мобилы рисуем bottom-sheet
    const cont = gridRef.current!;
    const y = top - scrollTop;
    const approxPanelH = panelRef.current?.offsetHeight || 220;
    const baseTop = y + height / 2 - approxPanelH / 2;
    const clampedTop = clamp(baseTop, 8, cont.clientHeight - approxPanelH - 8);
    setPanelTop(scrollTop + clampedTop);
  }, [top, height, scrollTop, gridRef, isMobile]);

  const canSave = valid && !!form.teacher && !!form.type;

  // -------- сам черновик (общий для моб/десктоп) --------
  const draftEl = (
    <div
      data-kind="block"
      className={`absolute left-3 right-3 select-none rounded-lg border px-3 py-2 text-sm shadow-lg ${valid ? "border-sky-400/40 bg-sky-400/10" : "border-rose-500/50 bg-rose-500/10"}`}
      style={{ top, height, touchAction: "none" as any }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div className="flex items-center justify-between text-sky-200/90">
        <div className="font-medium">{m2hm(draft.start)}–{m2hm(draft.end)}</div>
        <div className="text-xs uppercase tracking-wide opacity-80">Черновик</div>
      </div>
      <div className="mt-1 text-xs text-neutral-200/90">Перетащите, чтобы изменить время и длительность</div>

      <div role="separator" className="absolute inset-x-2 top-0 -translate-y-1/2 cursor-ns-resize rounded-full border border-sky-400/50 bg-sky-400/30 p-1" onPointerDown={(e) => onPointerDown(e, "resize-top")} title="Растянуть сверху" />
      <div role="separator" className="absolute inset-x-2 bottom-0 translate-y-1/2 cursor-ns-resize rounded-full border border-sky-400/50 bg-sky-400/30 p-1" onPointerDown={(e) => onPointerDown(e, "resize-bottom")} title="Растянуть снизу" />
      <div className="absolute inset-0 cursor-grab active:cursor-grabbing" onPointerDown={(e) => onPointerDown(e, "move")} title="Перетащить" />
    </div>
  );

  // -------- панель деталей (desktop) --------
  const desktopPanel = (
    <div
      data-kind="panel"
      ref={panelRef}
      className="pointer-events-auto absolute z-20 w-[280px] rounded-xl border border-neutral-700/70 bg-neutral-900/95 p-3 shadow-2xl backdrop-blur"
      style={{ top: panelTop, right: 12 }}
    >
      <PanelContent canSave={canSave} form={form} setForm={setForm} onSave={onSave} onCancel={onCancel} draft={draft} />
    </div>
  );

  // -------- панель деталей (mobile bottom-sheet — компактная, блокируем всплытие pointer) --------
  const [minimized, setMinimized] = useState(false);
  const mobilePanel = (
    <>
      {!minimized && (
        <div className="fixed inset-x-0 bottom-0 z-40 pointer-events-auto">
          <div
            data-kind="panel"
            onPointerDownCapture={(e) => e.stopPropagation()}
            onPointerUpCapture={(e) => e.stopPropagation()}
            onPointerMoveCapture={(e) => e.stopPropagation()}
            className="
              mx-auto max-w-md rounded-t-2xl border border-neutral-700/70
              bg-neutral-900/95 shadow-2xl backdrop-blur
              p-3 pb-[env(safe-area-inset-bottom)]
              max-h-[36vh] overflow-y-auto
            "
          >
            <div className="mx-auto mb-2 h-1.5 w-10 rounded-full bg-neutral-700/80" />
            <div className="mb-2 flex items-center justify-between text-sm">
              <div className="font-medium text-neutral-200">Детали брони</div>
              <button onClick={() => setMinimized(true)} className="text-xs text-neutral-400 underline underline-offset-4">Свернуть</button>
            </div>
            <PanelContent
              canSave={canSave}
              form={form}
              setForm={setForm}
              onSave={onSave}
              onCancel={onCancel}
              draft={draft}
            />
          </div>
        </div>
      )}
      {minimized && (
        <button
          data-kind="panel"
          onPointerDownCapture={(e) => e.stopPropagation()}
          onPointerUpCapture={(e) => e.stopPropagation()}
          onPointerMoveCapture={(e) => e.stopPropagation()}
          className="fixed bottom-3 right-3 z-40 rounded-full border border-neutral-700 bg-neutral-900/90 px-4 py-2 text-sm text-neutral-200 shadow-lg"
          onClick={() => setMinimized(false)}
          aria-label="Открыть детали"
        >
          Детали
        </button>
      )}
    </>
  );

  return (
    <>
      {draftEl}
      {isMobile ? mobilePanel : desktopPanel}
    </>
  );
}

// --- содержимое панелей (общая часть) ---
function PanelContent({
  canSave, form, setForm, onSave, onCancel, draft
}: {
  canSave: boolean;
  form: { teacher?: Teacher; type?: LessonType; note?: string };
  setForm: React.Dispatch<React.SetStateAction<{ teacher?: Teacher; type?: LessonType; note?: string }>>;
  onSave: () => void | Promise<void>;
  onCancel: () => void;
  draft: Draft;
}) {
  return (
    <>
      <div className="mb-2 flex items-center justify-between text-sm">
        <div className="text-xs text-neutral-500">{m2hm(draft.start)}–{m2hm(draft.end)}</div>
      </div>
      <div className="grid gap-2">
        <label className="text-xs text-neutral-400">Педагог</label>
        <select value={form.teacher ?? ""} onChange={(e) => setForm((f) => ({ ...f, teacher: e.target.value as Teacher }))} className="w-full rounded-lg border border-neutral-700 bg-neutral-800/80 px-2 py-2 text-sm outline-none focus:border-neutral-600">
          <option value="" disabled>Выберите педагога</option>
          {TEACHERS.map((t) => (<option key={t} value={t}>{t}</option>))}
        </select>

        <label className="mt-2 text-xs text-neutral-400">Тип</label>
        <select value={form.type ?? ""} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as LessonType }))} className="w-full rounded-lg border border-neutral-700 bg-neutral-800/80 px-2 py-2 text-sm outline-none focus:border-neutral-600">
          <option value="" disabled>Выберите тип</option>
          {TYPES.map((t) => (<option key={t} value={t}>{t}</option>))}
        </select>

        <label className="mt-2 text-xs text-neutral-400">Заметка (опционально)</label>
        <input type="text" maxLength={80} placeholder="Например: пробное, замена и т.п." value={form.note ?? ""} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} className="w-full rounded-lg border border-neutral-700 bg-neutral-800/80 px-3 py-2 text-sm outline-none placeholder:text-neutral-500 focus:border-neutral-600" />
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button onClick={onSave} disabled={!canSave} className={`inline-flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition ${canSave ? "bg-sky-500 text-white hover:bg-sky-400 active:scale-[.99]" : "cursor-not-allowed bg-neutral-700/70 text-neutral-300"}`}>
          <Save className="h-4 w-4" /> Сохранить
        </button>
        <button onClick={onCancel} className="inline-flex items-center justify-center gap-2 rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-800 active:scale-[.99]">
          <X className="h-4 w-4" /> Отмена
        </button>
      </div>
    </>
  );
}

// --- Экран «Занятость залов» ---
function OverviewScreen({ date, setDate, bookings, onDelete }: { date: string; setDate: (v: string) => void; bookings: Booking[]; onDelete: (id: string) => void | Promise<void> }) {
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const byRoom = useMemo(() => {
    const map: Record<Room, Booking[]> = { Белый: [], Серый: [], Черный: [] } as any;
    bookings
      .filter((b) => b.date === date)
      .sort((a, b) => a.start - b.start)
      .forEach((b) => map[b.room].push(b));
    return map;
  }, [bookings, date]);

  return (
    <main className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Занятость залов</h2>
          <p className="text-sm text-neutral-400">Выберите день, чтобы посмотреть текущие брони. Здесь можно удалять записи.</p>
        </div>
        <div className="relative w-full sm:w-[260px]">
          <CalendarIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-500" />
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full rounded-xl border border-neutral-700 bg-neutral-800/80 px-9 py-2 text-sm outline-none focus:border-neutral-600" />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {ROOMS.map((r) => (
          <div key={r} className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-medium text-neutral-200">{r}</div>
            </div>
            {byRoom[r].length === 0 ? (
              <div className="text-sm text-neutral-500">Нет броней</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {byRoom[r].map((b) => (
                  <span key={b.id} className="inline-flex items-center gap-2 rounded-full border border-neutral-700 bg-neutral-800/60 px-3 py-1 text-xs text-neutral-200" title={`${m2hm(b.start)}–${m2hm(b.end)} • ${b.teacher} • ${b.type}${b.note ? " — " + b.note : ""}`}>
                    <Clock3 className="h-3 w-3 opacity-70" /> {m2hm(b.start)}–{m2hm(b.end)}
                    <span className="opacity-70">•</span><span>{b.teacher}</span>
                    <span className="opacity-70">•</span><span className="text-neutral-300">{b.type}</span>
                    {pendingDeleteId === b.id ? (
                      <span className="ml-2 inline-flex items-center gap-1">
                        <button type="button" onClick={async (e) => { e.stopPropagation(); await onDelete(b.id); setPendingDeleteId(null); }} className="inline-flex items-center rounded-md border border-rose-600 px-2 py-[2px] text-[10px] hover:bg-rose-700/30" title="Подтвердить удаление">Да</button>
                        <button type="button" onClick={(e) => { e.stopPropagation(); setPendingDeleteId(null); }} className="inline-flex items-center rounded-md border border-neutral-600 px-2 py-[2px] text-[10px] hover:bg-neutral-700/50" title="Отмена удаления">Нет</button>
                      </span>
                    ) : (
                      <button type="button" onClick={(e) => { e.stopPropagation(); setPendingDeleteId(b.id); }} className="ml-1 inline-flex items-center rounded-md border border-neutral-600 px-1 py-[2px] text-[10px] hover:bg-neutral-700" title="Удалить бронь">
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </main>
  );
}

// Мини-проверки в рантайме (не мешают сборке)
(function runDevChecks() {
  try {
    console.assert(snapToStep(67, 15) === 60, "snapToStep 15->60");
    console.assert(snapToStep(74, 15) === 75, "snapToStep 15->75");
    console.assert(clamp(5, 10, 20) === 10, "clamp lower");
    console.assert(clamp(25, 10, 20) === 20, "clamp upper");
    console.assert(snapToStep(67) === 70, "default 10min -> 70");
    console.assert(m2hm(START_MIN) === "07:00", "start label");
  } catch (e) { console.warn("Dev checks failed:", e); }
})();

