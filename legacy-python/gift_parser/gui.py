"""Tkinter-интерфейс: ищешь подарок — видишь историю сделок и реальную цену."""

from __future__ import annotations

import queue
import threading
import time
import traceback
import webbrowser
from datetime import datetime
from pathlib import Path
from tkinter import BooleanVar, StringVar, Tk, Toplevel, filedialog, messagebox
from tkinter import ttk

import matplotlib

matplotlib.use("TkAgg")
import matplotlib.dates as mdates  # noqa: E402
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg  # noqa: E402
from matplotlib.figure import Figure  # noqa: E402

from . import images as imaging  # noqa: E402
from .rates import STAR, format_stars, format_usd  # noqa: E402
from .service import SOURCES, GiftPriceService, SearchQuery, SearchSession  # noqa: E402

BG = "#15161a"
PANEL = "#1d1f26"
PANEL_2 = "#252833"
HOVER = "#31364a"
TEXT = "#e8eaf0"
MUTED = "#8b90a0"
ACCENT = "#4c8dff"
GREEN = "#41c987"
RED = "#ff6b6b"
YELLOW = "#ffc65c"
MARKET_COLORS = {
    "MRKT": "#ff595a",
    "Portals": "#4c8dff",
    "Fragment": "#41c987",
    "Telegram": "#ffc65c",
    "Tonnel": "#c792ea",
}

ANY = "— любой —"
LIVE_INTERVAL_MS = 20_000      # как часто дотягивать свежие сделки
FLOOR_INTERVAL_MS = 60_000     # как часто обновлять флоры


class GiftPicker(ttk.Frame):
    """Поле поиска со всплывающим списком: картинка, название, флор."""

    def __init__(self, master, title: str, on_select=None, width: int = 26,
                 allow_any: bool = False) -> None:
        super().__init__(master, style="Panel.TFrame")
        self.on_select = on_select
        self.allow_any = allow_any
        self.search_fn = None
        self._rows: list = []
        self._icons: dict[str, object] = {}
        self._value: str | None = None
        self._popup: Toplevel | None = None
        self._tree: ttk.Treeview | None = None
        self._click_bind = None
        self._configure_bind = None

        ttk.Label(self, text=title, style="Muted.TLabel").pack(anchor="w")
        self.var = StringVar()
        self.entry = ttk.Entry(self, textvariable=self.var, width=width)
        self.entry.pack(fill="x")
        self.entry.bind("<KeyRelease>", self._on_key)
        self.entry.bind("<Button-1>", lambda _e: self._open())
        self.entry.bind("<FocusIn>", lambda _e: self._open())
        self.entry.bind("<FocusOut>", lambda _e: self.after(150, self._maybe_close))
        self.entry.bind("<Down>", lambda _e: self._move(1))
        self.entry.bind("<Up>", lambda _e: self._move(-1))
        self.entry.bind("<Return>", lambda _e: self._choose(prefer_typed=True))
        self.entry.bind("<Escape>", lambda _e: self._close())

    # ------------------------------------------------------------------- api
    def set_source(self, search_fn) -> None:
        """search_fn(query) -> список кортежей (name, subtitle, icon_getter)."""
        self.search_fn = search_fn

    @property
    def value(self) -> str | None:
        text = (self._value or self.var.get()).strip()
        if not text or text == ANY:
            return None
        return text

    def set_value(self, value: str | None) -> None:
        self._value = value
        self.var.set(value or "")

    def reset(self) -> None:
        self.set_value(None)

    # ----------------------------------------------------------------- список
    def _open(self) -> None:
        if self.search_fn is None or self._popup is not None:
            return
        root = self.winfo_toplevel()
        popup = Toplevel(self)
        popup.wm_overrideredirect(True)
        popup.transient(root)          # живёт вместе с окном приложения
        popup.configure(background=PANEL_2)
        frame = ttk.Frame(popup, style="Card.TFrame")
        frame.pack(fill="both", expand=True)
        tree = ttk.Treeview(frame, show="tree", columns=("info",), height=8,
                            style="Picker.Treeview", selectmode="browse")
        tree.column("#0", width=250, minwidth=180, stretch=True)
        tree.column("info", width=210, minwidth=180, anchor="e", stretch=False)
        tree.pack(side="left", fill="both", expand=True)
        scroll = ttk.Scrollbar(frame, orient="vertical", command=tree.yview)
        scroll.pack(side="right", fill="y")
        tree.configure(yscrollcommand=scroll.set)
        tree.bind("<ButtonRelease-1>", lambda _e: self._choose())
        tree.bind("<Return>", lambda _e: self._choose(prefer_typed=True))

        self._popup, self._tree = popup, tree
        self._place()
        self._refresh(self.var.get() if self._value is None else "")
        popup.lift()
        # Клик в любом другом месте приложения закрывает список,
        # как и перемещение/изменение размера окна.
        self._click_bind = root.bind_all("<Button-1>", self._on_global_click, add="+")
        self._configure_bind = root.bind("<Configure>", self._on_root_configure, add="+")

    def _place(self, rows: int = 8) -> None:
        """Ставит список под полем, не давая ему уехать за край экрана."""
        if self._popup is None:
            return
        self.update_idletasks()
        width = max(self.entry.winfo_width(), 480)
        height = max(96, min(rows, 8) * 42 + 12)
        screen_w = self._popup.winfo_screenwidth()
        screen_h = self._popup.winfo_screenheight()
        x = self.entry.winfo_rootx()
        x = max(4, min(x, screen_w - width - 8))
        below = self.entry.winfo_rooty() + self.entry.winfo_height() + 2
        above = self.entry.winfo_rooty() - height - 2
        y = below if below + height < screen_h - 8 else max(4, above)
        self._popup.geometry(f"{width}x{height}+{x}+{y}")

    def _refresh(self, query: str) -> None:
        if self._tree is None or self.search_fn is None:
            return
        self._tree.delete(*self._tree.get_children())
        self._icons.clear()
        rows = list(self.search_fn(query))
        if self.allow_any:
            rows.insert(0, (ANY, "", None))
        self._rows = rows
        for index, (name, subtitle, icon_getter) in enumerate(rows[:60]):
            icon = None
            if icon_getter is not None:
                try:
                    icon = icon_getter()
                except Exception:  # noqa: BLE001 - картинка не критична
                    icon = None
            if icon is not None:
                self._icons[str(index)] = icon
            self._tree.insert("", "end", iid=str(index), text=f" {name}",
                              values=(subtitle,), image=icon or "")
        children = self._tree.get_children()
        if children:
            index = 0
            if query.strip() and self.allow_any and len(children) > 1 and rows[0][0] == ANY:
                index = 1  # набранный текст важнее строки «любой»
            self._tree.selection_set(children[index])
            self._tree.see(children[index])
        self._place(rows=len(children))

    def _move(self, delta: int) -> str:
        if self._popup is None:
            self._open()
            return "break"
        children = self._tree.get_children() if self._tree else ()
        if not children:
            return "break"
        current = self._tree.selection()
        index = children.index(current[0]) if current else -1
        index = max(0, min(len(children) - 1, index + delta))
        self._tree.selection_set(children[index])
        self._tree.see(children[index])
        return "break"

    def _choose(self, prefer_typed: bool = False):
        """Подставляет выбранную строку. Возвращает "break", если событие съедено."""
        if self._tree is None:
            return None
        typed = self.var.get().strip().lower()
        name = None
        if prefer_typed and typed:
            for row in self._rows:
                if str(row[0]).strip().lower() == typed:
                    name = row[0]
                    break
        if name is None:
            selection = self._tree.selection()
            if not selection:
                # Ничего не выбрано — оставляем то, что напечатали.
                self._close()
                return None
            name = self._rows[int(selection[0])][0]
        self.set_value(None if name == ANY else name)
        self._close()
        self.entry.icursor("end")
        if self.on_select:
            self.on_select(self.value)
        return "break"

    def _on_key(self, event) -> None:
        if event.keysym in ("Up", "Down", "Return", "Escape", "Tab"):
            return
        self._value = None
        if self._popup is None:
            self._open()
        self._refresh(self.var.get())

    def _maybe_close(self) -> None:
        if self._popup is None:
            return
        under = self._popup.winfo_containing(
            self._popup.winfo_pointerx(), self._popup.winfo_pointery()
        )
        if under is None or str(under).startswith(str(self._popup)) is False:
            self._close()

    def _on_global_click(self, event) -> None:
        if self._popup is None:
            return
        widget = getattr(event, "widget", None)
        while widget is not None:
            if widget is self._popup or widget is self.entry:
                return
            widget = getattr(widget, "master", None)
        self._close()

    def _on_root_configure(self, _event=None) -> None:
        # Окно двигают или меняют размер — список уводим, чтобы не «висел» отдельно.
        self._close()

    def _close(self) -> None:
        root = self.winfo_toplevel()
        if self._click_bind is not None:
            try:
                root.unbind_all("<Button-1>")
            except Exception:  # noqa: BLE001
                pass
            self._click_bind = None
        if self._configure_bind is not None:
            try:
                root.unbind("<Configure>", self._configure_bind)
            except Exception:  # noqa: BLE001
                pass
            self._configure_bind = None
        if self._popup is not None:
            self._popup.destroy()
        self._popup = None
        self._tree = None


class ChartTooltip:
    """Всплывающая карточка над точкой графика."""

    def __init__(self, master, catalog, rates=None) -> None:
        self.master = master
        self.catalog = catalog
        self.rates = rates
        self.window: Toplevel | None = None
        self.current = None

    def _move(self, window, x: int, y: int) -> None:
        """Ставит карточку рядом с курсором, но всегда в пределах экрана."""
        window.update_idletasks()
        width = window.winfo_reqwidth()
        height = window.winfo_reqheight()
        screen_w = window.winfo_screenwidth()
        screen_h = window.winfo_screenheight()
        left = x + 16
        if left + width > screen_w - 8:
            left = x - width - 16
        left = max(8, min(left, screen_w - width - 8))
        top = y + 16
        if top + height > screen_h - 8:
            top = y - height - 16
        top = max(8, min(top, screen_h - height - 8))
        window.geometry(f"+{int(left)}+{int(top)}")

    def show(self, event, x: int, y: int) -> None:
        if self.current is event and self.window is not None:
            self._move(self.window, x, y)
            return
        self.hide()
        self.current = event

        window = Toplevel(self.master)
        window.wm_overrideredirect(True)
        window.transient(self.master)
        window.attributes("-topmost", True)
        window.configure(background=PANEL_2)
        frame = ttk.Frame(window, style="Card.TFrame", padding=10)
        frame.pack(fill="both", expand=True)

        colors = self.catalog.backdrop_color(event.backdrop)
        model_path = (
            self.catalog.image(event.collection, "models", event.model, download=False)
            if event.model else None
        )
        picture = imaging.gift_image(model_path, colors, size=104)
        photo = imaging.photo(picture, ("tooltip", str(model_path), event.backdrop, 104))
        label = ttk.Label(frame, image=photo, style="CardTitle.TLabel")
        label.image = photo
        label.pack(side="left", padx=(0, 12))

        info = ttk.Frame(frame, style="Card.TFrame")
        info.pack(side="left", fill="both", expand=True)
        title = event.gift_name or f"{event.collection} #{event.number or '?'}"
        ttk.Label(info, text=title, style="TipTitle.TLabel").pack(anchor="w")
        ttk.Label(info, text=f"{event.price:,.2f} TON".replace(",", " "),
                  style="TipPrice.TLabel").pack(anchor="w")
        if self.rates is not None:
            usd = self.rates.usd(event.price, event.ts, allow_fetch=False)
            buy = self.rates.stars(event.price, event.ts, allow_fetch=False)
            sell = self.rates.stars(event.price, event.ts, mode="sell", allow_fetch=False)
            money = ttk.Frame(info, style="Card.TFrame")
            money.pack(anchor="w", fill="x")
            if usd:
                ttk.Label(money, text=format_usd(usd), style="TipUsd.TLabel").pack(side="left")
            if buy:
                ttk.Label(money, text=format_stars(buy), style="TipStar.TLabel").pack(
                    side="left", padx=(8, 0))
            if sell:
                ttk.Label(info, text=f"продавцу за звёзды: {format_stars(sell)}",
                          style="CardTitle.TLabel").pack(anchor="w")
        rows = [
            ("Площадка", event.market),
            ("Событие", event.kind),
            ("Дата", event.ts.strftime("%d.%m.%Y %H:%M UTC")),
        ]
        if event.model:
            rows.append(("Модель", event.model))
        if event.backdrop:
            rows.append(("Фон", event.backdrop))
        if event.symbol:
            rows.append(("Символ", event.symbol))
        for name, value in rows:
            line = ttk.Frame(info, style="Card.TFrame")
            line.pack(anchor="w", fill="x")
            ttk.Label(line, text=f"{name}: ", style="CardTitle.TLabel").pack(side="left")
            ttk.Label(line, text=str(value), style="TipValue.TLabel").pack(side="left")

        self._move(window, x, y)
        self.window = window

    def hide(self) -> None:
        if self.window is not None:
            self.window.destroy()
        self.window = None
        self.current = None


class GiftParserApp:
    def __init__(self, root: Tk) -> None:
        self.root = root
        self.service: GiftPriceService | None = None
        self.session: SearchSession | None = None
        self.events_view: list = []
        self.busy = False
        self.loading_more = False
        self.messages: "queue.Queue[tuple[str, object]]" = queue.Queue()
        self._sort_state: dict[str, bool] = {}
        self._points: list = []
        self._auto_loads = 0
        self.source_vars: dict[str, BooleanVar] = {}
        self._live_job = None
        self._last_floors = 0.0
        self._active_sort: tuple[str, bool] | None = None

        root.title("Gift Price Parser — MRKT · Portals · Fragment · Telegram · Tonnel")
        root.geometry("1340x860")
        root.minsize(1120, 700)
        root.configure(bg=BG)

        self._init_style()
        self._build_layout()
        self.tooltip = ChartTooltip(root, None, None)
        self.root.after(80, self._pump)
        self._run(self._boot, "Подключение…")

    # ----------------------------------------------------------------- стиль
    def _init_style(self) -> None:
        style = ttk.Style(self.root)
        style.theme_use("clam")
        style.configure(".", background=BG, foreground=TEXT, fieldbackground=PANEL_2,
                        bordercolor=PANEL_2, lightcolor=PANEL, darkcolor=PANEL)
        style.configure("TFrame", background=BG)
        style.configure("Panel.TFrame", background=PANEL)
        style.configure("Card.TFrame", background=PANEL_2)
        style.configure("TLabel", background=BG, foreground=TEXT, font=("Segoe UI", 10))
        style.configure("Panel.TLabel", background=PANEL, foreground=TEXT)
        style.configure("Muted.TLabel", background=PANEL, foreground=MUTED, font=("Segoe UI", 9))
        style.configure("CardTitle.TLabel", background=PANEL_2, foreground=MUTED,
                        font=("Segoe UI", 9))
        style.configure("CardValue.TLabel", background=PANEL_2, foreground=TEXT,
                        font=("Segoe UI Semibold", 15))
        style.configure("TipTitle.TLabel", background=PANEL_2, foreground=TEXT,
                        font=("Segoe UI Semibold", 11))
        style.configure("TipPrice.TLabel", background=PANEL_2, foreground=GREEN,
                        font=("Segoe UI Semibold", 14))
        style.configure("TipValue.TLabel", background=PANEL_2, foreground=TEXT,
                        font=("Segoe UI", 9))
        style.configure("CardSub.TLabel", background=PANEL_2, foreground=MUTED,
                        font=("Segoe UI", 9))
        style.configure("CardStar.TLabel", background=PANEL_2, foreground=YELLOW,
                        font=("Segoe UI Semibold", 9))
        style.configure("TipStar.TLabel", background=PANEL_2, foreground=YELLOW,
                        font=("Segoe UI Semibold", 10))
        style.configure("TipUsd.TLabel", background=PANEL_2, foreground=TEXT,
                        font=("Segoe UI", 10))
        style.configure("Star.TLabel", background=BG, foreground=YELLOW,
                        font=("Segoe UI Semibold", 9))
        style.configure("Title.TLabel", background=BG, foreground=TEXT,
                        font=("Segoe UI Semibold", 14))
        style.configure("Status.TLabel", background=BG, foreground=MUTED, font=("Segoe UI", 9))
        style.configure("Floors.TLabel", background=BG, foreground=MUTED, font=("Segoe UI", 9))
        style.configure("TCheckbutton", background=PANEL, foreground=TEXT)
        style.map("TCheckbutton", background=[("active", PANEL)])
        style.configure("TButton", background=PANEL_2, foreground=TEXT, borderwidth=0,
                        padding=(12, 7), font=("Segoe UI", 10))
        style.map("TButton", background=[("active", HOVER), ("disabled", "#20222a")],
                  foreground=[("disabled", MUTED)])
        style.configure("Accent.TButton", background=ACCENT, foreground="#ffffff",
                        font=("Segoe UI Semibold", 10))
        style.map("Accent.TButton", background=[("active", "#3a7bef"), ("disabled", "#2a3450")])
        style.configure("TEntry", fieldbackground=PANEL_2, foreground=TEXT,
                        insertcolor=TEXT, padding=5)
        style.configure("TCombobox", fieldbackground=PANEL_2, background=PANEL_2,
                        foreground=TEXT, arrowcolor=TEXT, selectbackground=PANEL_2,
                        selectforeground=TEXT, padding=4)
        style.map("TCombobox", fieldbackground=[("readonly", PANEL_2)])
        self.root.option_add("*TCombobox*Listbox.background", PANEL_2)
        self.root.option_add("*TCombobox*Listbox.foreground", TEXT)
        self.root.option_add("*TCombobox*Listbox.selectBackground", ACCENT)
        style.configure("Treeview", background=PANEL, fieldbackground=PANEL, foreground=TEXT,
                        rowheight=26, borderwidth=0, font=("Segoe UI", 9))
        style.configure("Picker.Treeview", background=PANEL_2, fieldbackground=PANEL_2,
                        foreground=TEXT, rowheight=40, borderwidth=0, font=("Segoe UI", 10))
        style.configure("Treeview.Heading", background=PANEL_2, foreground=MUTED,
                        font=("Segoe UI Semibold", 9), relief="flat")
        style.map("Treeview.Heading", background=[("active", HOVER)])
        style.map("Treeview", background=[("selected", "#2e3550")],
                  foreground=[("selected", TEXT)])
        style.configure("TProgressbar", background=ACCENT, troughcolor=PANEL_2, borderwidth=0)

    # ---------------------------------------------------------------- разметка
    def _build_layout(self) -> None:
        header = ttk.Frame(self.root, padding=(16, 12, 16, 6))
        header.pack(fill="x")
        ttk.Label(header, text="Цены подарков Telegram", style="Title.TLabel").pack(side="left")
        self.auth_label = ttk.Label(header, text="Telegram: проверяю…", style="Status.TLabel")
        self.auth_label.pack(side="right")

        body = ttk.Frame(self.root, padding=(16, 6, 16, 12))
        body.pack(fill="both", expand=True)
        body.columnconfigure(1, weight=1)
        body.rowconfigure(0, weight=1)
        self._build_sidebar(body)
        self._build_content(body)

    def _build_sidebar(self, parent: ttk.Frame) -> None:
        side = ttk.Frame(parent, style="Panel.TFrame", padding=14)
        side.grid(row=0, column=0, sticky="ns", padx=(0, 14))

        ttk.Label(side, text="Подарок", style="Panel.TLabel",
                  font=("Segoe UI Semibold", 11)).pack(anchor="w", pady=(0, 8))

        self.collection_picker = GiftPicker(side, "Коллекция", self._on_collection)
        self.collection_picker.pack(fill="x", pady=(0, 8))
        self.model_picker = GiftPicker(side, "Модель", allow_any=True)
        self.model_picker.pack(fill="x", pady=(0, 8))
        self.backdrop_picker = GiftPicker(side, "Фон", allow_any=True)
        self.backdrop_picker.pack(fill="x", pady=(0, 8))
        self.symbol_picker = GiftPicker(side, "Символ", allow_any=True)
        self.symbol_picker.pack(fill="x", pady=(0, 8))

        ttk.Label(side, text="Площадки", style="Muted.TLabel").pack(anchor="w", pady=(12, 2))
        for source in SOURCES:
            var = BooleanVar(value=source.default_on)
            self.source_vars[source.key] = var
            text = source.title
            if not source.history:
                text += " (лоты)"
            ttk.Checkbutton(side, text=text, variable=var).pack(anchor="w")

        self.only_sales = BooleanVar(value=True)
        ttk.Checkbutton(side, text="Только продажи", variable=self.only_sales).pack(
            anchor="w", pady=(8, 0))
        self.live_var = BooleanVar(value=True)
        ttk.Checkbutton(side, text="Обновлять в реальном времени",
                        variable=self.live_var).pack(anchor="w")

        self.search_button = ttk.Button(side, text="Искать", style="Accent.TButton",
                                        command=self.on_search)
        self.search_button.pack(fill="x", pady=(14, 6))
        self.export_button = ttk.Button(side, text="Экспорт CSV", command=self.on_export,
                                        state="disabled")
        self.export_button.pack(fill="x")
        ttk.Button(side, text="Обновить каталог", command=self.on_refresh_catalog).pack(
            fill="x", pady=(6, 0))

        self.progress = ttk.Progressbar(side, mode="indeterminate", length=200)
        self.progress.pack(fill="x", pady=(14, 4))
        self.status_var = StringVar(value="Готов")
        ttk.Label(side, textvariable=self.status_var, style="Muted.TLabel",
                  wraplength=230, justify="left").pack(anchor="w")

        self.root.bind("<Return>", lambda _e: self.on_search())

    def _build_content(self, parent: ttk.Frame) -> None:
        content = ttk.Frame(parent)
        content.grid(row=0, column=1, sticky="nsew")
        content.columnconfigure(0, weight=1)
        content.rowconfigure(3, weight=1)

        cards = ttk.Frame(content)
        cards.grid(row=0, column=0, sticky="ew")
        self.cards: dict[str, ttk.Label] = {}
        self.card_titles: dict[str, ttk.Label] = {}
        self.card_usd: dict[str, ttk.Label] = {}
        self.card_stars: dict[str, ttk.Label] = {}
        for index, (key, title) in enumerate([
            ("median", "Медиана"),
            ("trimmed", "Средняя без выбросов"),
            ("last", "Последняя продажа"),
            ("range", "Мин — Макс"),
            ("count", "Сделок"),
            ("floor", "Флор (минимум)"),
        ]):
            cards.columnconfigure(index, weight=1)
            card = ttk.Frame(cards, style="Card.TFrame", padding=(12, 10))
            card.grid(row=0, column=index, sticky="ew", padx=(0 if index == 0 else 8, 0))
            caption = ttk.Label(card, text=title, style="CardTitle.TLabel")
            caption.pack(anchor="w")
            value = ttk.Label(card, text="—", style="CardValue.TLabel")
            value.pack(anchor="w")
            sub = ttk.Frame(card, style="Card.TFrame")
            sub.pack(anchor="w", fill="x")
            usd = ttk.Label(sub, text="", style="CardSub.TLabel")
            usd.pack(side="left")
            stars = ttk.Label(sub, text="", style="CardStar.TLabel")
            stars.pack(side="left", padx=(6, 0))
            self.cards[key] = value
            self.card_titles[key] = caption
            self.card_usd[key] = usd
            self.card_stars[key] = stars

        floors_row = ttk.Frame(content)
        floors_row.grid(row=1, column=0, sticky="ew", pady=(8, 0))
        self.floors_var = StringVar(value="")
        ttk.Label(floors_row, textvariable=self.floors_var, style="Floors.TLabel").pack(side="left")
        self.rate_var = StringVar(value="")
        ttk.Label(floors_row, textvariable=self.rate_var, style="Star.TLabel").pack(
            side="right")

        chart_frame = ttk.Frame(content, style="Panel.TFrame", padding=6)
        chart_frame.grid(row=2, column=0, sticky="ew", pady=(8, 12))
        self.figure = Figure(figsize=(8, 2.7), dpi=100, facecolor=PANEL)
        self.axes = self.figure.add_subplot(111)
        self._reset_chart("Выбери подарок и нажми «Искать»")
        self.canvas = FigureCanvasTkAgg(self.figure, master=chart_frame)
        self.canvas.get_tk_widget().pack(fill="both", expand=True)
        self.canvas.mpl_connect("motion_notify_event", self._on_chart_motion)
        self.canvas.mpl_connect("figure_leave_event", lambda _e: self.tooltip.hide())
        self.canvas.mpl_connect("axes_leave_event", lambda _e: self.tooltip.hide())

        table_frame = ttk.Frame(content, style="Panel.TFrame")
        table_frame.grid(row=3, column=0, sticky="nsew")
        table_frame.rowconfigure(0, weight=1)
        table_frame.columnconfigure(0, weight=1)

        columns = ("ts", "market", "kind", "model", "backdrop", "symbol", "number",
                   "price", "usd", "stars")
        headers = {
            "ts": ("Дата (UTC)", 125), "market": ("Площадка", 85), "kind": ("Событие", 90),
            "model": ("Модель", 140), "backdrop": ("Фон", 110), "symbol": ("Символ", 110),
            "number": ("№", 60), "price": ("Цена, TON", 95),
            "usd": ("Цена, $", 90), "stars": (f"Цена, {STAR}", 95),
        }
        self.tree = ttk.Treeview(table_frame, columns=columns, show="headings",
                                 selectmode="browse")
        for key in columns:
            title, width = headers[key]
            self.tree.heading(key, text=title, command=lambda k=key: self._sort_by(k))
            anchor = "e" if key in ("price", "number", "usd", "stars") else "w"
            self.tree.column(key, width=width, anchor=anchor,
                             stretch=key in ("model", "symbol"))
        self.tree.grid(row=0, column=0, sticky="nsew")
        for market, color in MARKET_COLORS.items():
            self.tree.tag_configure(market, foreground=color)
        self.tree.bind("<Double-1>", self._open_link)
        self.tree.bind("<MouseWheel>", self._on_wheel, add="+")

        scroll = ttk.Scrollbar(table_frame, orient="vertical", command=self._on_scroll)
        scroll.grid(row=0, column=1, sticky="ns")
        self.scrollbar = scroll
        self.tree.configure(yscrollcommand=self._on_tree_scroll)

    def _reset_chart(self, message: str | None = None) -> None:
        self.axes.clear()
        self.axes.set_facecolor(PANEL)
        for spine in self.axes.spines.values():
            spine.set_color("#333846")
        self.axes.tick_params(colors=MUTED, labelsize=8)
        self.axes.grid(color="#2a2f3d", linewidth=0.6)
        if message:
            self.axes.text(0.5, 0.5, message, ha="center", va="center", color=MUTED,
                           fontsize=10, transform=self.axes.transAxes)
            self.axes.set_xticks([])
            self.axes.set_yticks([])
        self.figure.tight_layout()

    # ----------------------------------------------------------------- потоки
    def _run(self, func, status: str, quiet: bool = False) -> None:
        if self.busy:
            return
        self.busy = True
        if not quiet:
            # Фоновые обновления не мигают кнопкой и прогрессом.
            self.search_button.configure(state="disabled")
            self.status_var.set(status)
            self.progress.start(12)

        def worker() -> None:
            try:
                func()
            except Exception as exc:  # noqa: BLE001
                self.messages.put(("error", (str(exc), traceback.format_exc())))
            finally:
                self.messages.put(("done", None))

        threading.Thread(target=worker, daemon=True).start()

    def _pump(self) -> None:
        try:
            while True:
                kind, payload = self.messages.get_nowait()
                if kind == "status":
                    self.status_var.set(str(payload))
                elif kind == "auth":
                    ok, text = payload  # type: ignore[misc]
                    self.auth_label.configure(text=text, foreground=GREEN if ok else RED)
                elif kind == "ready":
                    self._bind_pickers()
                elif kind == "result":
                    self._apply_result()
                elif kind == "live":
                    count = int(payload or 0)
                    self._apply_result()
                    stamp = datetime.now().strftime("%H:%M:%S")
                    if count:
                        self.status_var.set(f"{stamp} — новых сделок: +{count}")
                    else:
                        self.status_var.set(f"{stamp} — новых сделок нет")
                elif kind == "error":
                    message, detail = payload  # type: ignore[misc]
                    self.status_var.set("Ошибка")
                    messagebox.showerror("Ошибка", f"{message}\n\n{detail[-1200:]}")
                elif kind == "done":
                    self.busy = False
                    self.loading_more = False
                    self.progress.stop()
                    self.search_button.configure(state="normal")
        except queue.Empty:
            pass
        self.root.after(80, self._pump)

    # ------------------------------------------------------------------ шаги
    def _boot(self) -> None:
        self.service = GiftPriceService()
        self.tooltip.catalog = self.service.catalog
        self.tooltip.rates = self.service.rates
        logged = self.service.is_logged_in()
        if logged:
            self.messages.put(("auth", (True, "Telegram: вход выполнен")))
        else:
            self.messages.put((
                "auth",
                (False, "Telegram: нет входа — запусти  python cli.py login"),
            ))
        catalog = self.service.catalog
        collections = catalog.collections()
        self.messages.put(("status", f"Коллекций в каталоге: {len(collections)}"))
        self.messages.put(("ready", None))
        try:
            added = self.service.rates.refresh(
                on_progress=lambda text: self.messages.put(("status", text))
            )
            rates = self.service.rates
            self.messages.put((
                "status",
                f"Курс TON: {len(rates.prices)} дней (+{added}), сейчас "
                f"{format_usd(rates.spot_price())}",
            ))
        except Exception as exc:  # noqa: BLE001 - без курса просто не будет $ и ★
            self.messages.put(("status", f"Курс TON не загрузился: {exc}"))
        # Иконки коллекций: локальные берутся мгновенно, недостающие докачиваем.
        missing = 0
        for info in collections:
            if catalog.collection_icon(info.short_name, download=False) is None:
                if catalog.collection_icon(info.short_name):
                    missing += 1
        if missing:
            self.messages.put(("status", f"Иконки коллекций загружены (+{missing})"))

    def _bind_pickers(self) -> None:
        catalog = self.service.catalog  # type: ignore[union-attr]

        def collections(query: str):
            rows = []
            for info in catalog.search_collections(query, limit=60):
                rows.append((
                    info.name,
                    info.subtitle,
                    lambda short=info.short_name: imaging.thumb_photo(
                        catalog.collection_icon(short, download=False)
                    ),
                ))
            return rows

        def attributes(kind: str):
            def search(query: str):
                collection = self.collection_picker.value
                if not collection:
                    return []
                rows = []
                for item in catalog.search_attributes(collection, kind, query, limit=60):
                    rows.append((
                        item.name,
                        item.subtitle,
                        lambda it=item: imaging.thumb_photo(
                            catalog.image(it.collection, it.kind, it.name, download=False),
                            colors=it.colors,
                        ),
                    ))
                return rows

            return search

        self.collection_picker.set_source(collections)
        self.model_picker.set_source(attributes("models"))
        self.backdrop_picker.set_source(attributes("backdrops"))
        self.symbol_picker.set_source(attributes("symbols"))

    def _on_collection(self, _value) -> None:
        for picker in (self.model_picker, self.backdrop_picker, self.symbol_picker):
            picker.reset()
        collection = self.collection_picker.value
        if not collection or self.service is None:
            return
        # Подтягиваем картинки моделей в фоне, чтобы список открывался с иконками.
        def warm() -> None:
            catalog = self.service.catalog  # type: ignore[union-attr]
            catalog.collection_icon(collection)
            for item in catalog.attributes(collection, "models")[:24]:
                catalog.image(collection, "models", item.name)
            self.messages.put(("status", f"{collection}: каталог готов"))

        self._run(warm, f"{collection}: картинки…", quiet=True)

    # ------------------------------------------------------------------ поиск
    def on_search(self) -> None:
        if self.service is None:
            return
        if self.busy:
            # Идёт фоновое обновление — повторим клик через мгновение.
            self.root.after(400, self.on_search)
            return
        collection = self.collection_picker.value
        if not collection:
            messagebox.showinfo("Нужна коллекция", "Выбери коллекцию подарка.")
            return
        sources = tuple(key for key, var in self.source_vars.items() if var.get())
        if not sources:
            messagebox.showinfo("Нет площадок", "Отметь хотя бы одну площадку.")
            return

        query = SearchQuery(
            collection=collection,
            model=self.model_picker.value,
            backdrop=self.backdrop_picker.value,
            symbol=self.symbol_picker.value,
            days=None,
            sources=sources,
            only_sales=self.only_sales.get(),
        )
        self.session = self.service.session(query)
        self.events_view = []
        self._auto_loads = 0
        self._active_sort = None
        self._sort_state.clear()
        self.tree.delete(*self.tree.get_children())
        self.tooltip.hide()

        def work() -> None:
            self.session.prepare(  # type: ignore[union-attr]
                on_progress=lambda text: self.messages.put(("status", text))
            )
            self.messages.put(("result", None))

        self._run(work, "Ищу…")
        self._last_floors = time.time()
        self._schedule_live()

    def _schedule_live(self) -> None:
        if self._live_job is not None:
            try:
                self.root.after_cancel(self._live_job)
            except Exception:  # noqa: BLE001
                pass
        self._live_job = self.root.after(LIVE_INTERVAL_MS, self._live_tick)

    def _live_tick(self) -> None:
        self._live_job = None
        session = self.session
        if session is None or not self.live_var.get() or self.busy:
            self._schedule_live()
            return
        want_floors = time.time() - self._last_floors > FLOOR_INTERVAL_MS / 1000

        def work() -> None:
            fresh = session.refresh_new()
            if want_floors:
                session.refresh_floors()
                self._last_floors = time.time()
            self.messages.put(("live", len(fresh)))

        self._run(work, "", quiet=True)
        self._schedule_live()

    def _load_more(self) -> None:
        if self.busy or self.session is None or self.session.finished:
            return
        self.loading_more = True

        def work() -> None:
            self.session.load_more(  # type: ignore[union-attr]
                on_progress=lambda text: self.messages.put(("status", text))
            )
            self.messages.put(("result", None))

        self._run(work, "Подгружаю ещё…", quiet=True)

    # -------------------------------------------------------------- результаты
    def _apply_result(self) -> None:
        if self.session is None:
            return
        result = self.session.result
        stats = result.stats

        def fmt(value) -> str:
            return "—" if value is None else f"{value:,.2f}".replace(",", " ")

        rates = self.service.rates if self.service else None

        def sub(key: str, ton: float | None, moment=None) -> None:
            if rates is None or not ton:
                self.card_usd[key].configure(text="")
                self.card_stars[key].configure(text="")
                return
            usd = rates.usd(ton, moment, allow_fetch=False)
            stars = rates.stars(ton, moment, allow_fetch=False)
            self.card_usd[key].configure(text=format_usd(usd) if usd else "")
            self.card_stars[key].configure(text=format_stars(stars) if stars else "")

        self.cards["median"].configure(text=f"{fmt(stats.median)} TON" if stats.count else "—")
        sub("median", stats.median if stats.count else None)
        sub("trimmed", stats.trimmed_average if stats.count else None)
        sub("last", stats.last_price, stats.last_ts)
        self.cards["trimmed"].configure(
            text=f"{fmt(stats.trimmed_average)} TON" if stats.count else "—")
        if stats.last_price is not None:
            self.cards["last"].configure(text=f"{fmt(stats.last_price)} TON")
            self.card_titles["last"].configure(
                text=f"Последняя продажа · {self._humanize(stats.last_ts)}")
        else:
            self.cards["last"].configure(text="—")
            self.card_titles["last"].configure(text="Последняя продажа")
        self.cards["range"].configure(
            text=f"{fmt(stats.minimum)} — {fmt(stats.maximum)}" if stats.count else "—")
        counts = ", ".join(f"{market}: {count}" for market, count in stats.per_market.items())
        self.cards["count"].configure(text=f"{stats.count}" + (f"  ({counts})" if counts else ""))
        if result.floors:
            best_market = min(result.floors, key=result.floors.get)
            self.cards["floor"].configure(text=f"{fmt(result.floors[best_market])} TON")
            self.card_titles["floor"].configure(text=f"Флор · {best_market}")
        else:
            self.cards["floor"].configure(text="—")
            self.card_titles["floor"].configure(text="Флор (минимум)")

        floors_parts = []
        for market, price in sorted(result.floors.items()):
            usd = rates.usd(price, allow_fetch=False) if rates else None
            floors_parts.append(
                f"{market} {fmt(price)}" + (f" ({format_usd(usd)})" if usd else "")
            )
        floors = "   ".join(floors_parts)
        if result.official:
            info = result.official
            floors += (
                f"      Оценка Telegram: {fmt(info.get('average'))} {info.get('currency', '')}"
                f" · лотов {info.get('listed_count')}"
            )
        self.floors_var.set(floors)
        if result.floors and rates:
            best = min(result.floors.values())
            stars = rates.stars(best, allow_fetch=False)
            rate = rates.spot or rates.prices.get(rates.last_day or "")
            self.rate_var.set(
                (f"флор {format_stars(stars)}   " if stars else "")
                + (f"TON ≈ {format_usd(rate)}" if rate else "")
            )
        sub("floor", min(result.floors.values()) if result.floors else None)

        self.events_view = list(result.events)
        if self._active_sort:
            column, descending = self._active_sort
            self._apply_sort(column, descending)
        else:
            self._fill_table(self.events_view)
        self._draw_chart(result)

        parts = [f"Сделок {len(result.sales)} за {result.elapsed:.1f} с"]
        if self.session.finished:
            parts.append("вся история загружена")
        else:
            parts.append("прокрути таблицу вниз — подгружу ещё")
        for name, error in result.errors.items():
            parts.append(f"{name}: {error}")
        self.status_var.set("\n".join(parts))
        self.export_button.configure(state="normal" if result.events else "disabled")

    def _fill_table(self, events: list) -> None:
        try:
            position = self.tree.yview()[0]
        except Exception:  # noqa: BLE001
            position = 0.0
        self.tree.delete(*self.tree.get_children())
        rates = self.service.rates if self.service else None
        for index, event in enumerate(events):
            usd = stars = None
            if rates is not None:
                usd = rates.usd(event.price, event.ts, allow_fetch=False)
                stars = rates.stars(event.price, event.ts, allow_fetch=False)
            self.tree.insert(
                "", "end", iid=str(index),
                values=(
                    event.ts.strftime("%Y-%m-%d %H:%M"),
                    event.market,
                    event.kind,
                    event.model or "",
                    event.backdrop or "",
                    event.symbol or "",
                    event.number or "",
                    f"{event.price:,.2f}".replace(",", " "),
                    format_usd(usd) if usd else "",
                    format_stars(stars) if stars else "",
                ),
                tags=(event.market,),
            )
        if position:
            self.tree.yview_moveto(position)

    def _draw_chart(self, result) -> None:
        sales = result.sales
        self._points = []
        if not sales:
            self._reset_chart("Нет продаж за выбранный период")
            self.canvas.draw()
            return
        self._reset_chart()
        for market in sorted({event.market for event in sales}):
            points = [event for event in sales if event.market == market]
            self.axes.scatter(
                [event.ts for event in points], [event.price for event in points],
                s=20, alpha=0.9, label=f"{market} ({len(points)})",
                color=MARKET_COLORS.get(market, ACCENT), edgecolors="none", picker=True,
            )
            self._points.extend(points)
        median = result.stats.median
        self.axes.axhline(median, color=GREEN, linewidth=1.2, linestyle="--",
                          label=f"медиана {median:,.0f}".replace(",", " "))
        for market, floor in result.floors.items():
            self.axes.axhline(floor, color=MARKET_COLORS.get(market, MUTED), linewidth=0.9,
                              alpha=0.45, linestyle=":")
        self.axes.xaxis.set_major_formatter(mdates.DateFormatter("%d.%m"))
        self.axes.set_ylabel("TON", color=MUTED, fontsize=8)
        legend = self.axes.legend(loc="upper left", fontsize=8, facecolor=PANEL_2,
                                  edgecolor="#333846", labelcolor=TEXT)
        legend.get_frame().set_alpha(0.9)
        self.figure.tight_layout()
        self.canvas.draw()

    # ------------------------------------------------------------- интерактив
    def _on_chart_motion(self, mpl_event) -> None:
        if not self._points or mpl_event.inaxes is not self.axes:
            self.tooltip.hide()
            return
        best = None
        best_distance = 1e9
        for event in self._points:
            x, y = self.axes.transData.transform((mdates.date2num(event.ts), event.price))
            distance = ((x - mpl_event.x) ** 2 + (y - mpl_event.y) ** 2) ** 0.5
            if distance < best_distance:
                best, best_distance = event, distance
        if best is None or best_distance > 14:
            self.tooltip.hide()
            return
        widget = self.canvas.get_tk_widget()
        height = widget.winfo_height()
        self.tooltip.show(
            best,
            widget.winfo_rootx() + int(mpl_event.x),
            widget.winfo_rooty() + int(height - mpl_event.y),
        )

    def _on_tree_scroll(self, first, last) -> None:
        self.scrollbar.set(first, last)
        if float(last) > 0.92:
            self._maybe_load_more()

    def _on_scroll(self, *args) -> None:
        self._auto_loads = 0
        self.tree.yview(*args)
        if float(self.tree.yview()[1]) > 0.92:
            self._maybe_load_more()

    def _on_wheel(self, _event=None) -> None:
        # Живая прокрутка колесом снова разрешает автоподгрузку.
        self._auto_loads = 0

    def _maybe_load_more(self) -> None:
        if self.busy or self.loading_more or self.session is None or self.session.finished:
            return
        # Пока таблица короче экрана, доливаем сами, но не бесконечно.
        if self._auto_loads >= 3:
            return
        self._auto_loads += 1
        self._load_more()

    def _sort_by(self, column: str) -> None:
        if not self.events_view:
            return
        descending = not self._sort_state.get(column, False)
        self._sort_state[column] = descending
        self._active_sort = (column, descending)
        self._apply_sort(column, descending)

    def _apply_sort(self, column: str, descending: bool) -> None:
        keys = {
            "ts": lambda e: e.ts, "market": lambda e: e.market, "kind": lambda e: e.kind,
            "model": lambda e: (e.model or ""), "backdrop": lambda e: (e.backdrop or ""),
            "symbol": lambda e: (e.symbol or ""), "number": lambda e: (e.number or 0),
            "price": lambda e: e.price, "usd": lambda e: e.price, "stars": lambda e: e.price,
        }
        self.events_view.sort(key=keys.get(column, keys["ts"]), reverse=descending)
        self._fill_table(self.events_view)

    def _open_link(self, _event=None) -> None:
        selection = self.tree.selection()
        if not selection:
            return
        event = self.events_view[int(selection[0])]
        if event.link:
            webbrowser.open(event.link)

    def on_export(self) -> None:
        if self.session is None or not self.session.result.events:
            return
        query = self.session.result.query
        name = "_".join(filter(None, [
            query.collection.replace(" ", ""), (query.model or "").replace(" ", "")
        ])) or "gifts"
        path = filedialog.asksaveasfilename(defaultextension=".csv", initialfile=f"{name}.csv",
                                            filetypes=[("CSV", "*.csv")])
        if path:
            self.session.result.to_csv(Path(path))
            self.status_var.set(f"Сохранено: {path}")

    def on_refresh_catalog(self) -> None:
        if self.busy or self.service is None:
            return

        def work() -> None:
            result = self.service.catalog.refresh(  # type: ignore[union-attr]
                on_progress=lambda text: self.messages.put(("status", text))
            )
            self.messages.put(("status", f"Каталог обновлён: {result['collections']} коллекций"))

        self._run(work, "Обновляю каталог…")

    @staticmethod
    def _humanize(moment: datetime | None) -> str:
        if moment is None:
            return ""
        delta = datetime.now(moment.tzinfo) - moment
        hours = delta.total_seconds() / 3600
        if hours < 1:
            return f"{int(delta.total_seconds() // 60)} мин назад"
        if hours < 48:
            return f"{int(hours)} ч назад"
        return f"{int(hours // 24)} дн назад"


def main() -> None:
    try:  # чёткий текст на Windows с масштабированием
        import ctypes

        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except Exception:  # noqa: BLE001
        pass
    root = Tk()
    GiftParserApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
