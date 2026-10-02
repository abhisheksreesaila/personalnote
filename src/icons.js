// The icons the app draws, and only those: the whole Lucide set is most of a megabyte and the page would carry all of it.
// An icon is named in the markup as <i data-lucide="kebab-name"></i>; add its PascalCase export here when you use a new one.
import {
  AlignLeft, Archive, ArrowLeft, ArrowUpDown, AudioLines, Braces, Check, ChevronDown, ChevronRight, CornerDownLeft, Download,
  Eraser, FileDown, FileText, Focus, FolderDown, FolderInput, FolderOpen, Gauge, GitBranch, GitFork, Hand, HardDrive, ImageDown,
  ImagePlus, Inbox, LayoutGrid, Maximize2, Mic, Minus, MoreHorizontal, MousePointer2, NotebookTabs, PanelLeft, Pencil, Plus,
  Printer, Redo2, Scan, Search, SearchX, Share, SlidersHorizontal, Square, StickyNote, Trash2, Undo2, WandSparkles, X, createIcons as createLucideIcons,
} from 'lucide'

export const icons = {
  AlignLeft, Archive, ArrowLeft, ArrowUpDown, AudioLines, Braces, Check, ChevronDown, ChevronRight, CornerDownLeft, Download,
  Eraser, FileDown, FileText, Focus, FolderDown, FolderInput, FolderOpen, Gauge, GitBranch, GitFork, Hand, HardDrive, ImageDown,
  ImagePlus, Inbox, LayoutGrid, Maximize2, Mic, Minus, MoreHorizontal, MousePointer2, NotebookTabs, PanelLeft, Pencil, Plus,
  Printer, Redo2, Scan, Search, SearchX, Share, SlidersHorizontal, Square, StickyNote, Trash2, Undo2, WandSparkles, X,
}

// Replaces every <i data-lucide> in the page (or in `root`) with its icon.
export const createIcons = (options = {}) => createLucideIcons({ icons, ...options })
