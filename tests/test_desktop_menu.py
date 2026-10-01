import json
import shutil
import sys
import threading
import types
from unittest import mock
import subprocess
import unittest
from pathlib import Path

import desktop_menu as dm
import desktop
from desktop import window_url

ROOT = Path(__file__).resolve().parent.parent


class FakeWindow:
    def __init__(self):
        self.scripts, self.minimized = [], 0

    def evaluate_js(self, script):
        self.scripts.append(script)

    def minimize(self):
        self.minimized += 1


class FakeItem:
    def __init__(self, title="", action="", key=""):
        self._title, self._sub, self.action, self.key, self.mask, self.target, self.represented = title, None, action, key, 0, None, None

    @classmethod
    def alloc(cls):
        return cls()

    def init(self):
        return self

    def initWithTitle_action_keyEquivalent_(self, title, action, key):
        self._title, self.action, self.key = title, action, key
        return self

    @staticmethod
    def separatorItem():
        return FakeItem("---")

    def title(self): return self._title
    def setTitle_(self, t): self._title = t
    def submenu(self): return self._sub
    def setSubmenu_(self, m): self._sub = m
    def setKeyEquivalent_(self, k): self.key = k
    def setKeyEquivalentModifierMask_(self, m): self.mask = m
    def setTarget_(self, t): self.target = t
    def setHidden_(self, h): self.hidden = h
    def setAllowsKeyEquivalentWhenHidden_(self, a): self.allows_hidden = a
    def setRepresentedObject_(self, o): self.represented = o


class FakeMenu:
    def __init__(self, title=""):
        self._title, self.items = title, []

    @classmethod
    def alloc(cls):
        return cls()

    def init(self):
        return self

    def title(self): return self._title
    def setTitle_(self, t): self._title = t
    def itemArray(self): return list(self.items)
    def insertItem_atIndex_(self, item, index): self.items.insert(index, item)
    def indexOfItem_(self, item): return self.items.index(item)
    def removeItem_(self, item): self.items.remove(item)

    def add(self, title, *children):
        item = FakeItem(title)
        sub = FakeMenu(title)
        sub.items = [FakeItem(c) for c in children]
        item.setSubmenu_(sub)
        self.items.append(item)
        return sub


class FakeApp:
    def __init__(self, main):
        self.main, self.windows, self.help = main, None, None

    def mainMenu(self): return self.main
    def setWindowsMenu_(self, m): self.windows = m
    def setHelpMenu_(self, m): self.help = m


def pywebview_like_main_menu():
    """App, Edit, View (defaults), then the custom menus: the order pywebview 6.2.1 builds."""
    main = FakeMenu()
    main.add("", "About", "Quit")
    main.add("Edit", "Cut", "Copy", "Paste", "Select All")
    main.add("View", "Enter Fullscreen")
    main.add("File", *[i.title for i in dm.iter_items(dm.FILE_ITEMS)])
    main.add("Window", "Minimize", "Zoom")
    main.add("Help", "Personal Note on GitHub")
    main.items[0].submenu().items.insert(1, FakeItem("Settings…"))
    return main


class FakeAppKit:
    NSMenuItem, NSMenu = FakeItem, FakeMenu

    def __init__(self, main):
        self.app = FakeApp(main)
        self.NSApplication = type("NSApplication", (), {"sharedApplication": staticmethod(lambda: self.app)})


class FakeHandler:
    def __init__(self):
        self.actions = {}

    def register_action(self, action_id, fn):
        self.actions[action_id] = fn


class MenuModelTests(unittest.TestCase):
    def test_every_command_is_one_the_page_understands(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node not available")
        script = "import('./src/modules/desktop/commands.js').then((m) => console.log(JSON.stringify(m.COMMAND_NAMES)))"
        names = json.loads(subprocess.run([node, "-e", script], cwd=ROOT, capture_output=True, text=True, check=True).stdout)
        used = {item.command for item in dm.iter_items() if item.command}
        self.assertTrue(used <= set(names), used - set(names))

    def test_titles_are_unique_so_shortcuts_find_their_items(self):
        titles = [item.title for item in dm.iter_items()]
        self.assertEqual(len(titles), len(set(titles)))

    def test_each_item_has_exactly_one_effect(self):
        for item in dm.iter_items():
            self.assertEqual(bool(item.command) + bool(item.action), 1, item.title)

    def test_standard_shortcuts(self):
        by_title = {item.title: item for item in dm.iter_items()}
        cmd, shift = dm.MODIFIER_FLAGS["command"], dm.MODIFIER_FLAGS["shift"]
        expect = {"New note": ("n", cmd), "Print…": ("p", cmd), "Settings…": (",", cmd), "Undo": ("z", cmd),
                  "Redo": ("z", cmd | shift), "Zoom In": ("=", cmd), "Zoom In (plus key)": ("+", cmd | shift), "Zoom Out": ("-", cmd), "Fit": ("0", cmd),
                  "Minimize": ("m", cmd), "Speed meter": ("f", cmd | shift)}
        for title, (key, mask) in expect.items():
            self.assertEqual((by_title[title].key, dm.modifier_mask(by_title[title].mods)), (key, mask), title)

    def test_quick_note_has_no_key_equivalent_so_option_n_still_types_a_tilde(self):
        quick = next(i for i in dm.iter_items() if i.title == "Quick note")
        self.assertEqual(quick.key, "")

    def test_command_script_quotes_the_name(self):
        self.assertEqual(dm.command_script("zoom-in"), 'window.personalNote && window.personalNote.command("zoom-in")')
        self.assertNotIn("'; alert", dm.command_script("a'); alert(1); ('"))
        self.assertIn(json.dumps("a'); alert(1); ('"), dm.command_script("a'); alert(1); ('"))

    def test_url_flags_only_on_macos(self):
        self.assertEqual(window_url("http://127.0.0.1:5000", "darwin"), "http://127.0.0.1:5000/notes?host=desktop&chrome=mac")
        self.assertEqual(window_url("http://127.0.0.1:5000", "linux"), "http://127.0.0.1:5000/notes?host=desktop")
        self.assertEqual(window_url("http://127.0.0.1:5000", "win32"), "http://127.0.0.1:5000/notes?host=desktop")


class MenuActionTests(unittest.TestCase):
    def setUp(self):
        self.window, self.zoomed, self.opened = FakeWindow(), [], []
        self.actions = dm.MenuActions(self.window, lambda: self.zoomed.append(1), self.opened.append)

    def test_page_commands_call_the_page(self):
        self.assertTrue(self.actions.run(dm.Item("New note", command="new-note")))
        self.assertEqual(self.window.scripts, [dm.command_script("new-note")])

    def test_window_and_help_actions(self):
        self.actions.run(dm.Item("Minimize", action="minimize"))
        self.actions.run(dm.Item("Zoom", action="zoom"))
        self.actions.run(dm.Item("Help", action="open-help"))
        self.assertEqual((self.window.minimized, self.zoomed, self.opened), (1, [1], [dm.REPOSITORY_URL]))

    def test_a_failing_action_is_swallowed(self):
        self.window.evaluate_js = lambda script: (_ for _ in ()).throw(RuntimeError("page gone"))
        with self.assertLogs("personal-note.desktop", "WARNING"):
            self.assertFalse(self.actions.run(dm.Item("Undo", command="undo")))

    def test_unknown_action_is_refused(self):
        self.assertFalse(self.actions.run(dm.Item("Nope", action="nope")))

    def test_webview_menus_mirror_the_model(self):
        class Menu:
            def __init__(self, title, items=()): self.title, self.items = title, list(items)
        class Action:
            def __init__(self, title, function): self.title, self.function = title, function
        class Sep: pass
        menus = dm.webview_menus(self.actions, Menu, Action, Sep)
        self.assertEqual([m.title for m in menus], ["__app__", "File", "Window", "Help"])
        file_menu = menus[1]
        self.assertEqual([type(i).__name__ for i in file_menu.items], ["Action", "Action", "Sep", "Action", "Action", "Sep", "Action"])
        file_menu.items[0].function()
        self.assertEqual(self.window.scripts, [dm.command_script("new-note")])


class NativeMenuTests(unittest.TestCase):
    def install(self):
        main = pywebview_like_main_menu()
        kit, handler = FakeAppKit(main), FakeHandler()
        window = FakeWindow()
        ok = dm.install_native_menu(dm.MenuActions(window, lambda: None), appkit=kit, handler=handler)
        return ok, main, kit, handler, window

    def titles(self, menu):
        return [i.title() for i in menu.items]

    def test_menu_order_and_edit_and_view_extras(self):
        ok, main, kit, handler, _ = self.install()
        self.assertTrue(ok)
        self.assertEqual(self.titles(main), ["", "File", "Edit", "View", "Window", "Help"])
        edit = main.items[2].submenu()
        self.assertEqual(self.titles(edit)[:3], ["Undo", "Redo", "---"])
        self.assertEqual(self.titles(edit)[3:], ["Cut", "Copy", "Paste", "Select All"])
        view = main.items[3].submenu()
        self.assertEqual(self.titles(view), ["Zoom In", "Zoom In (plus key)", "Zoom Out", "Fit", "---", "Skins", "Speed meter", "---", "Enter Fullscreen"])
        self.assertEqual(self.titles(view.items[5].submenu()), ["Crayon", "Paper", "Night"])

    def test_native_items_run_their_command_and_carry_shortcuts(self):
        ok, main, kit, handler, window = self.install()
        undo = main.items[2].submenu().items[0]
        self.assertEqual((undo.key, undo.mask), ("z", dm.MODIFIER_FLAGS["command"]))
        self.assertEqual(undo.action, "handleMenuAction:")
        handler.actions[undo.represented]()
        self.assertEqual(window.scripts, [dm.command_script("undo")])
        night = main.items[3].submenu().items[5].submenu().items[2]
        handler.actions[night.represented]()
        self.assertEqual(window.scripts[-1], dm.command_script("skin-night"))

    def test_pywebview_items_get_shortcuts(self):
        ok, main, kit, handler, _ = self.install()
        new_note = next(i for i in main.items[1].submenu().items if i.title() == "New note")
        self.assertEqual((new_note.key, new_note.mask), ("n", dm.MODIFIER_FLAGS["command"]))
        settings = main.items[0].submenu().items[1]
        self.assertEqual(settings.key, ",")
        self.assertIs(kit.app.windows, main.items[4].submenu())
        self.assertIs(kit.app.help, main.items[5].submenu())

    def test_standard_edit_items_are_left_to_the_responder_chain(self):
        ok, main, *_ = self.install()
        for item in main.items[2].submenu().items[3:]:
            self.assertEqual(item.key, "")  # pywebview's own items keep their native actions

    def test_a_native_failure_is_logged_and_never_raised(self):
        class Broken:
            @property
            def NSApplication(self):
                raise RuntimeError("no AppKit")
        with self.assertLogs("personal-note.desktop", "WARNING"):
            self.assertFalse(dm.install_native_menu(dm.MenuActions(FakeWindow(), lambda: None), appkit=Broken(), handler=FakeHandler()))

    def test_missing_main_menu_is_not_an_error(self):
        kit = FakeAppKit(None)
        self.assertFalse(dm.install_native_menu(dm.MenuActions(FakeWindow(), lambda: None), appkit=kit, handler=FakeHandler()))


class GuardTests(unittest.TestCase):
    def test_install_twice_adds_nothing_twice(self):
        main = pywebview_like_main_menu()
        kit, handler = FakeAppKit(main), FakeHandler()
        actions = dm.MenuActions(FakeWindow(), lambda: None)
        dm.install_native_menu(actions, appkit=kit, handler=handler)
        once = [[i.title() for i in m.submenu().items] for m in main.items if m.submenu()]
        dm.install_native_menu(actions, appkit=kit, handler=handler)
        twice = [[i.title() for i in m.submenu().items] for m in main.items if m.submenu()]
        self.assertEqual(once, twice)

    def test_the_hidden_plus_item_is_hidden(self):
        main = pywebview_like_main_menu()
        dm.install_native_menu(dm.MenuActions(FakeWindow(), lambda: None), appkit=FakeAppKit(main), handler=FakeHandler())
        plus = next(i for i in main.items[3].submenu().items if i.title() == "Zoom In (plus key)")
        self.assertTrue(plus.hidden)
        self.assertTrue(plus.allows_hidden)

    def test_guard_stops_pywebview_rebuilding_and_restores_after_one(self):
        main = pywebview_like_main_menu()
        kit, handler = FakeAppKit(main), FakeHandler()
        actions = dm.MenuActions(FakeWindow(), lambda: None)
        menus = ["the", "menus"]
        blocks = []
        kit.NSWindowDidBecomeKeyNotification = "key"
        kit.NSNotificationCenter = type("C", (), {"defaultCenter": staticmethod(lambda: types.SimpleNamespace(
            addObserverForName_object_queue_usingBlock_=lambda name, obj, queue, block: blocks.append((name, obj, block))))})
        cocoa = types.SimpleNamespace(BrowserView=types.SimpleNamespace(current_menu=None))
        native = object()
        ok = dm.install_menu_guard(native, actions, menus, appkit=kit, cocoa=cocoa, call_after=lambda fn: fn())
        self.assertTrue(ok)
        self.assertIs(cocoa.BrowserView.current_menu, menus)  # same list as webview.start(menu=...): no rebuild
        self.assertEqual(blocks[0][:2], ("key", native))
        # Simulate a rebuild that wipes the additions, then the observer firing: the additions come back.
        calls = []
        with mock.patch.object(dm, "install_native_menu", lambda a, **kw: calls.append(a) or True):
            blocks[0][2](None)
        self.assertEqual(calls, [actions])

    def test_guard_failure_is_logged(self):
        with self.assertLogs("personal-note.desktop", "WARNING"):
            self.assertFalse(dm.install_menu_guard(object(), None, [], appkit=object(), cocoa=object(), call_after=lambda f: f()))


class TitleBarTests(unittest.TestCase):
    def test_title_bar_background_is_cleared(self):
        seen = []
        class NSTitlebarContainerView:
            setBackgroundColor_ = staticmethod(lambda c: seen.append(c))
        container = NSTitlebarContainerView()
        native = types.SimpleNamespace(contentView=lambda: types.SimpleNamespace(superview=lambda: types.SimpleNamespace(
            subviews=lambda: types.SimpleNamespace(lastObject=lambda: container))))
        kit = types.SimpleNamespace(NSColor=types.SimpleNamespace(clearColor=lambda: "clear"))
        self.assertTrue(dm.clear_title_bar_background(native, appkit=kit))
        self.assertEqual(seen, ["clear"])
        with self.assertLogs("personal-note.desktop", "WARNING"):
            self.assertFalse(dm.clear_title_bar_background(object(), appkit=kit))
        other = types.SimpleNamespace(setBackgroundColor_=lambda c: seen.append("wrong"))
        native2 = types.SimpleNamespace(contentView=lambda: types.SimpleNamespace(superview=lambda: types.SimpleNamespace(
            subviews=lambda: types.SimpleNamespace(lastObject=lambda: other))))
        with self.assertLogs("personal-note.desktop", "WARNING"):
            self.assertFalse(dm.clear_title_bar_background(native2, appkit=kit))
        self.assertEqual(seen, ["clear"])

    def test_style_flags(self):
        calls = []

        class Native:
            def setTitlebarAppearsTransparent_(self, v): calls.append(("transparent", v))
            def setTitleVisibility_(self, v): calls.append(("title", v))
            def styleMask(self): return 0b1111
            def setStyleMask_(self, m): calls.append(("mask", m))
            def zoom_(self, sender): calls.append(("zoom", sender))

        native = Native()
        dm.style_unified_title_bar(native)
        dm.zoom_native_window(native)
        self.assertEqual(calls, [("transparent", True), ("title", 1), ("mask", 0b1111 | (1 << 15)), ("zoom", None)])
        self.assertFalse(dm.is_full_screen(native))
        native.styleMask = lambda: 1 << 14
        self.assertTrue(dm.is_full_screen(native))


class Event:
    def __init__(self):
        self.handlers = []

    def __iadd__(self, handler):
        self.handlers.append(handler)
        return self


class MacWindow(FakeWindow):
    def __init__(self, native):
        super().__init__()
        self.native = native
        self.events = types.SimpleNamespace(shown=Event(), maximized=Event(), restored=Event())
        self.called = threading.Event()

    def evaluate_js(self, script):
        super().evaluate_js(script)
        self.called.set()


class MacSetupTests(unittest.TestCase):
    def setUp(self):
        helper = types.SimpleNamespace(callAfter=lambda fn: fn())
        modules = {"PyObjCTools": types.SimpleNamespace(AppHelper=helper), "PyObjCTools.AppHelper": helper}
        patcher = mock.patch.dict(sys.modules, modules)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.installed = []
        install = mock.patch.object(dm, "install_native_menu", lambda actions, **kw: self.installed.append(actions) or True)
        install.start()
        self.addCleanup(install.stop)

    def native(self, mask=0b1111):
        calls = []
        return types.SimpleNamespace(
            calls=calls, mask=mask,
            setTitlebarAppearsTransparent_=lambda v: calls.append("transparent"),
            setTitleVisibility_=lambda v: calls.append("title"),
            styleMask=lambda: mask,
            setStyleMask_=lambda m: calls.append("mask"),
        )

    def test_after_show_styles_the_window_and_installs_the_menu(self):
        native = self.native()
        window = MacWindow(native)
        actions = dm.MenuActions(window, lambda: None)
        desktop.setup_mac_window(window, actions)
        window.events.shown.handlers[0]()
        self.assertEqual(native.calls, ["transparent", "title", "mask"])
        self.assertEqual(self.installed, [actions])
        self.assertEqual(window.scripts, [])

    def test_when_styling_fails_the_page_is_told_to_drop_the_reserved_space(self):
        native = self.native()
        native.setTitlebarAppearsTransparent_ = lambda v: (_ for _ in ()).throw(RuntimeError("no"))
        window = MacWindow(native)
        desktop.setup_mac_window(window, dm.MenuActions(window, lambda: None))
        with self.assertLogs("personal-note.desktop", "WARNING"):
            window.events.shown.handlers[0]()
        self.assertTrue(window.called.wait(2))
        self.assertIn("setMacChrome(false)", window.scripts[0])

    def test_full_screen_changes_reach_the_page(self):
        native = self.native(mask=1 << 14)
        window = MacWindow(native)
        desktop.setup_mac_window(window, dm.MenuActions(window, lambda: None))
        with mock.patch.object(dm, "on_main_thread", lambda fn, timeout=5.0: fn()):
            window.events.maximized.handlers[0]()
            native.styleMask = lambda: 0
            window.events.restored.handlers[0]()
        self.assertEqual([("setFullscreen(true)" in s, "setFullscreen(false)" in s) for s in window.scripts], [(True, False), (False, True)])

    def test_zoom_api_reports_failure_instead_of_raising(self):
        self.assertTrue(desktop.DesktopApi(lambda: None).zoom_window())
        with self.assertLogs("personal-note.desktop", "WARNING"):
            self.assertFalse(desktop.DesktopApi(lambda: 1 / 0).zoom_window())


if __name__ == "__main__":
    unittest.main()
