// The icons the app draws, and only those: the whole Lucide set is most of a megabyte and the page would carry all of it.
// An icon is named in the markup as <i data-lucide="kebab-name"></i>; add its PascalCase export here when you use a new one.
import {
  AlignLeft, Archive, ArrowLeft, AudioLines, BookOpen, Braces, Check, ChevronDown, ChevronRight, Compass, Download,
  Eraser, FileDown, FilePen, FileText, Focus, FoldVertical, FolderDown, FolderInput, FolderOpen, Gauge, GitBranch, GitFork, Hand, HardDrive, ImageDown,
  ImagePlus, Inbox, LayoutGrid, Maximize2, Mic, Minus, MoreHorizontal, MousePointer2, PanelLeft, Pencil, Plus,
  Printer, Redo2, Scan, Search, SlidersHorizontal, Square, StickyNote, Target, Trash2, Undo2, UnfoldVertical, WandSparkles, X, createIcons as createLucideIcons,
} from 'lucide'

export const icons = {
  AlignLeft, Archive, ArrowLeft, AudioLines, BookOpen, Braces, Check, ChevronDown, ChevronRight, Compass, Download,
  Eraser, FileDown, FilePen, FileText, Focus, FoldVertical, FolderDown, FolderInput, FolderOpen, Gauge, GitBranch, GitFork, Hand, HardDrive, ImageDown,
  ImagePlus, Inbox, LayoutGrid, Maximize2, Mic, Minus, MoreHorizontal, MousePointer2, PanelLeft, Pencil, Plus,
  Printer, Redo2, Scan, Search, SlidersHorizontal, Square, StickyNote, Target, Trash2, Undo2, UnfoldVertical, WandSparkles, X,
}

// Secure notes (F-058). Added here, not in the lists above, so a change to those never clashes with this.
import { Fingerprint, Lock, LockOpen, Palette, ShieldCheck, Zap } from 'lucide'
Object.assign(icons, { Fingerprint, Lock, LockOpen, Palette, ShieldCheck, Zap })

// The dynamic island (F-084).
import { Sparkles, TriangleAlert } from 'lucide'
Object.assign(icons, { Sparkles, TriangleAlert })

// Replaces every <i data-lucide> in the page (or in `root`) with its icon.
export const createIcons = (options = {}) => createLucideIcons({ icons, ...options })

// Notebook icons (F-089): the picker's list (ICON_NAMES in modules/library/notebook-icon.js).
import {
  Baby, Bookmark, Book, Briefcase, Brain, Calendar, Camera, Car, Coffee, CookingPot, Code, Film, FlaskConical, Flag, Folder, Gamepad2, GraduationCap, Globe,
  Heart, House, Leaf, Lightbulb, Link, Map, Moon, Music, PawPrint, Plane, Rocket, ShoppingCart, Star, Sun, Users, Wallet, Dumbbell,
} from 'lucide'
Object.assign(icons, {
  Baby, Bookmark, Book, Briefcase, Brain, Calendar, Camera, Car, Coffee, CookingPot, Code, Film, FlaskConical, Flag, Folder, Gamepad2, GraduationCap, Globe,
  Heart, House, Leaf, Lightbulb, Link, Map, Moon, Music, PawPrint, Plane, Rocket, ShoppingCart, Star, Sun, Users, Wallet, Dumbbell,
})
