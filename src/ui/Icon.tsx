import type { ButtonHTMLAttributes } from 'react';
import {
  Add, Archive, ArrowsUpDown, Bot, Checkmark, ChevronLeft, ChevronRight,
  Close, Code, Download, Flag, Grid, Handshake, Home, Icon as QuartzIcon, Keyboard, Link, List, Menu, Move, Play, Save, Settings,
  SkipBackward, SkipForward, StopOutline, Swap, Trophy, Undo, User, UserAvatar,
} from '../components/quartz/icon';

// The game UI draws the same Font Awesome Classic Solid family as the landing page, through
// Quartz's icon entry point, under the short names its call sites already use.
const icons = {
  account: UserAvatar,
  archive: Archive,
  back: ChevronLeft,
  board: Grid,
  bot: Bot,
  change: Swap,
  check: Checkmark,
  close: Close,
  code: Code,
  download: Download,
  draw: Handshake,
  first: SkipBackward,
  flag: Flag,
  flip: ArrowsUpDown,
  handshake: Handshake,
  home: Home,
  keyboard: Keyboard,
  last: SkipForward,
  link: Link,
  menu: Menu,
  move: Move,
  moves: List,
  next: ChevronRight,
  play: Play,
  plus: Add,
  resign: Flag,
  save: Save,
  settings: Settings,
  stop: StopOutline,
  trophy: Trophy,
  undo: Undo,
  user: User,
} as const;

export type IconName = keyof typeof icons;

export function Icon({ name, label }: { name: IconName; label?: string }) {
  return <QuartzIcon icon={icons[name]} size={20} {...(label ? { label } : {})} />;
}
export function IconButton({ icon, label, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  return <button type="button" className="button quiet icon-button" aria-label={label} title={label} {...props}><Icon name={icon} /></button>;
}
