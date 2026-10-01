"""The macOS menu bar and window chrome for the pywebview window (F-022).

Pure parts (the menu model, command scripts, URL flags, modifier masks) are unit-tested anywhere.
The AppKit parts only run on macOS, are guarded, and never raise: a native call that fails is
logged and skipped, and the app keeps working with pywebview's default menus. UNVERIFIED on a Mac.

How it fits together:
- pywebview builds the app menu (About, Services, Hide, Quit), a default Edit menu (Cut, Copy, Paste,
  Select All: the standard responder actions WKWebView needs for its text fields) and a default View
  menu (Enter Full Screen), then appends the menus declared here (File, Window, Help, and Settings in
  the app menu).
- `install_native_menu` then adds Undo/Redo to Edit and the zoom, skin and speed-meter items to View,
  moves File next to the app menu, and gives every item here its key equivalent, which pywebview's
  menu API cannot express.
- A menu item never synthesizes keystrokes: it calls `window.personalNote.command(name)` in the page.
"""

from __future__ import annotations

import json
import logging
import sys
import threading
from dataclasses import dataclass
from typing import Any, Callable

logger = logging.getLogger("personal-note.desktop")

REPOSITORY_URL = "https://github.com/abhisheksreesaila/personalnote"

# NSEventModifierFlag* values (AppKit constants; written out so the model is testable off macOS).
MODIFIER_FLAGS = {"shift": 1 << 17, "control": 1 << 18, "option": 1 << 19, "command": 1 << 20}
NS_WINDOW_TITLE_HIDDEN = 1
NS_FULL_SIZE_CONTENT_VIEW = 1 << 15
NS_FULL_SCREEN = 1 << 14


@dataclass(frozen=True)
class Item:
    """One menu item: a page `command`, or a Python `action`, with its optional shortcut."""

    title: str
    command: str | None = None
    action: str | None = None
    key: str = ""
    mods: tuple[str, ...] = ("command",)
    hidden: bool = False  # an extra key equivalent that is not shown in the menu


@dataclass(frozen=True)
class Submenu:
    title: str
    items: tuple


SEPARATOR = None

APP_ITEMS = (Item("Settings…", command="settings", key=","),)

FILE_ITEMS = (
    Item("New note", command="new-note", key="n"),
    # Option+N is also the dead key for ñ, so the page owns it (and blocks it while typing); no key here.
    Item("Quick note", command="quick-note"),
    SEPARATOR,
    Item("Export backup…", command="export-backup"),
    Item("Export Markdown…", command="export-markdown"),
    SEPARATOR,
    Item("Print…", command="print", key="p"),
)

# Added at the top of pywebview's default Edit menu (Cut, Copy, Paste, Select All stay native).
EDIT_ITEMS = (
    Item("Undo", command="undo", key="z"),
    Item("Redo", command="redo", key="z", mods=("command", "shift")),
    SEPARATOR,
)

# Added at the top of pywebview's default View menu (Enter Full Screen stays native).
VIEW_ITEMS = (
    Item("Zoom In", command="zoom-in", key="="),  # ⌘= works on US layouts; ⇧⌘= (a "+") is the hidden item below
    Item("Zoom In (plus key)", command="zoom-in", key="+", mods=("command", "shift"), hidden=True),
    Item("Zoom Out", command="zoom-out", key="-"),
    Item("Fit", command="zoom-fit", key="0"),
    SEPARATOR,
    Submenu("Skins", (
        Item("Crayon", command="skin-crayon", mods=()),
        Item("Paper", command="skin-paper", mods=()),
        Item("Night", command="skin-night", mods=()),
    )),
    Item("Speed meter", command="speed-meter", key="f", mods=("command", "shift")),
    SEPARATOR,
)

WINDOW_ITEMS = (
    Item("Minimize", action="minimize", key="m"),
    Item("Zoom", action="zoom"),
)

HELP_ITEMS = (Item("Personal Note on GitHub", action="open-help"),)

CUSTOM_MENUS = (("File", FILE_ITEMS), ("Window", WINDOW_ITEMS), ("Help", HELP_ITEMS))


def iter_items(*groups):
    """Every Item in the given groups (default: the whole model), submenus flattened."""
    if not groups:
        groups = (APP_ITEMS, FILE_ITEMS, EDIT_ITEMS, VIEW_ITEMS, WINDOW_ITEMS, HELP_ITEMS)
    for group in groups:
        for entry in group:
            if isinstance(entry, Submenu):
                yield from iter_items(entry.items)
            elif isinstance(entry, Item):
                yield entry


def command_script(name: str) -> str:
    """JavaScript that runs one page command; the name is JSON-quoted, never concatenated raw."""
    return f"window.personalNote && window.personalNote.command({json.dumps(name)})"


def modifier_mask(mods: tuple[str, ...]) -> int:
    mask = 0
    for name in mods:
        mask |= MODIFIER_FLAGS[name]
    return mask


def window_url(base_url: str, platform: str = sys.platform) -> str:
    # window.pywebview is injected after page load; the flags let the page know at once that it is the
    # desktop app and, on macOS, that its content runs under a transparent title bar.
    flags = "?host=desktop&chrome=mac" if platform == "darwin" else "?host=desktop"
    return f"{base_url}/notes{flags}"


class MenuActions:
    """Runs menu items against a pywebview window. Every method swallows and logs its failures."""

    def __init__(self, window, zoom_window: Callable[[], None], open_url: Callable[[str], Any] | None = None):
        self.window = window
        self.zoom_window = zoom_window
        self.open_url = open_url

    def run(self, item: Item) -> bool:
        try:
            if item.command:
                self.window.evaluate_js(command_script(item.command))
            elif item.action == "minimize":
                self.window.minimize()
            elif item.action == "zoom":
                self.zoom_window()
            elif item.action == "open-help":
                opener = self.open_url
                if opener is None:
                    import webbrowser

                    opener = webbrowser.open
                opener(REPOSITORY_URL)
            else:
                return False
            return True
        except Exception:
            logger.warning("Menu item %r failed.", item.title, exc_info=True)
            return False

    def runner(self, item: Item) -> Callable[[], bool]:
        return lambda: self.run(item)


def webview_menus(actions: MenuActions, menu_cls, action_cls, separator_cls) -> list:
    """The menus pywebview builds itself, as its own Menu objects (classes injected for testing)."""

    def convert(entries):
        out = []
        for entry in entries:
            if entry is SEPARATOR:
                out.append(separator_cls())
            elif isinstance(entry, Submenu):
                out.append(menu_cls(entry.title, convert(entry.items)))
            else:
                out.append(action_cls(entry.title, actions.runner(entry)))
        return out

    menus = [menu_cls("__app__", convert(APP_ITEMS))]
    menus += [menu_cls(title, convert(items)) for title, items in CUSTOM_MENUS]
    return menus


# ---- AppKit (macOS only) --------------------------------------------------------------------


def on_main_thread(function: Callable[[], Any], timeout: float = 5.0) -> Any:
    """Run `function` on the AppKit main thread and return its result (None if it fails or times out)."""
    from PyObjCTools import AppHelper

    done = threading.Event()
    box: dict[str, Any] = {}

    def call():
        try:
            box["value"] = function()
        except Exception:
            logger.warning("A native window call failed.", exc_info=True)
        finally:
            done.set()

    AppHelper.callAfter(call)
    done.wait(timeout)
    return box.get("value")


def style_unified_title_bar(native) -> None:
    """Content under a transparent title bar, no title text; the traffic lights stay."""
    native.setTitlebarAppearsTransparent_(True)
    native.setTitleVisibility_(NS_WINDOW_TITLE_HIDDEN)
    native.setStyleMask_(native.styleMask() | NS_FULL_SIZE_CONTENT_VIEW)
    clear_title_bar_background(native)


def clear_title_bar_background(native, appkit: Any = None) -> bool:
    """pywebview paints the title-bar container with the window colour; clear it so the page shows through."""
    try:
        if appkit is None:
            import AppKit as appkit  # noqa: N813
        native.contentView().superview().subviews().lastObject().setBackgroundColor_(appkit.NSColor.clearColor())
        return True
    except Exception:
        logger.warning("Could not clear the title bar background.", exc_info=True)
        return False


def is_full_screen(native) -> bool:
    return bool(native.styleMask() & NS_FULL_SCREEN)


def zoom_native_window(native) -> None:
    native.zoom_(None)


def _find_item(menu, title: str):
    """Depth-first search for the NSMenuItem with this title."""
    for item in menu.itemArray():
        if str(item.title()) == title:
            return item
        sub = item.submenu()
        if sub is not None:
            found = _find_item(sub, title)
            if found is not None:
                return found
    return None


def _submenu(menu, title: str):
    for item in menu.itemArray():
        sub = item.submenu()
        if sub is not None and (str(sub.title()) == title or str(item.title()) == title):
            return sub
    return None


def install_native_menu(actions: MenuActions, appkit: Any = None, handler: Any = None) -> bool:
    """Adds the native-only items and key equivalents. Call on the main thread after the window is shown.

    Returns True when the menu was completed; a failure part way is logged and leaves what exists.
    """
    try:
        if appkit is None:
            import AppKit as appkit  # noqa: N813
        if handler is None:
            from webview.platforms.cocoa import menu_handler as handler
        app = appkit.NSApplication.sharedApplication()
        main = app.mainMenu()
        if main is None:
            return False

        counter = [0]

        def make_item(entry: Item):
            counter[0] += 1
            action_id = f"personalnote.{counter[0]}.{entry.command or entry.action}"
            handler.register_action(action_id, actions.runner(entry))
            item = appkit.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(entry.title, "handleMenuAction:", "")
            item.setTarget_(handler)
            item.setRepresentedObject_(action_id)
            apply_shortcut(item, entry)
            if entry.hidden:
                item.setHidden_(True)
            return item

        def apply_shortcut(item, entry: Item):
            if entry.key:
                item.setKeyEquivalent_(entry.key)
                item.setKeyEquivalentModifierMask_(modifier_mask(entry.mods))

        def fill(menu, entries, start: int) -> None:
            index = start
            for entry in entries:
                if entry is SEPARATOR:
                    menu.insertItem_atIndex_(appkit.NSMenuItem.separatorItem(), index)
                elif isinstance(entry, Submenu):
                    holder = appkit.NSMenuItem.alloc().init()
                    holder.setTitle_(entry.title)
                    sub = appkit.NSMenu.alloc().init()
                    sub.setTitle_(entry.title)
                    holder.setSubmenu_(sub)
                    menu.insertItem_atIndex_(holder, index)
                    fill(sub, entry.items, 0)
                else:
                    menu.insertItem_atIndex_(make_item(entry), index)
                index += 1

        edit = _submenu(main, "Edit")
        if edit is not None:
            if _find_item(edit, "Undo") is None:  # idempotent: a second run only refreshes shortcuts
                fill(edit, EDIT_ITEMS, 0)
        else:
            logger.warning("No Edit menu to add Undo and Redo to.")
        view = _submenu(main, "View")
        if view is not None:
            if _find_item(view, "Fit") is None:
                fill(view, VIEW_ITEMS, 0)
        else:
            logger.warning("No View menu to add the zoom items to.")

        # pywebview's own items (File, Window, Help, Settings…) only need their shortcuts.
        for entry in iter_items(APP_ITEMS, FILE_ITEMS, WINDOW_ITEMS, HELP_ITEMS):
            item = _find_item(main, entry.title)
            if item is not None:
                apply_shortcut(item, entry)

        # File belongs right after the application menu: App, File, Edit, View, Window, Help.
        file_item = next((i for i in main.itemArray() if str(i.title()) == "File"), None)
        if file_item is not None and main.indexOfItem_(file_item) != 1:
            main.removeItem_(file_item)
            main.insertItem_atIndex_(file_item, 1)

        window_menu = _submenu(main, "Window")
        if window_menu is not None:
            app.setWindowsMenu_(window_menu)
        help_menu = _submenu(main, "Help")
        if help_menu is not None:
            app.setHelpMenu_(help_menu)
        return True
    except Exception:
        logger.warning("Could not finish the macOS menu bar; the default menus stay.", exc_info=True)
        return False


def install_menu_guard(native, actions: MenuActions, menus: Any, appkit: Any = None, cocoa: Any = None, call_after: Callable | None = None) -> bool:
    """Keeps the added menu items when pywebview rebuilds its menu.

    pywebview's window delegate rebuilds the whole menu on becoming key whenever BrowserView.current_menu
    differs from the window's menu list, which would wipe our additions. Setting current_menu to that same
    list stops the rebuild, and a become-key observer re-runs the (idempotent) install as a second defence.
    """
    try:
        if appkit is None:
            import AppKit as appkit  # noqa: N813
        if cocoa is None:
            from webview.platforms import cocoa
        if call_after is None:
            from PyObjCTools import AppHelper

            call_after = AppHelper.callAfter
        cocoa.BrowserView.current_menu = menus
        center = appkit.NSNotificationCenter.defaultCenter()

        def became_key(_notification):
            call_after(lambda: install_native_menu(actions))  # next loop turn, after pywebview's own delegate

        center.addObserverForName_object_queue_usingBlock_(appkit.NSWindowDidBecomeKeyNotification, native, None, became_key)
        return True
    except Exception:
        logger.warning("Could not guard the macOS menu against rebuilds.", exc_info=True)
        return False
