import { useLayoutEffect, useRef } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Icon, IconButton } from '../ui/Icon';
import type { IconName } from '../ui/Icon';
import './left-game-rail.css';

type RailTool = 'settings' | 'archive';

interface Props {
  readonly tool: RailTool | 'position' | 'move' | null;
  readonly recoveryOpen: boolean;
  readonly showConversation: boolean;
  readonly onNewGame: () => void;
  readonly onBoard: () => void;
  readonly onTool: (tool: RailTool) => void;
  readonly onDownload: () => void;
  readonly onAccount?: (() => void) | undefined;
  readonly menuOpen: boolean;
  readonly onMenuOpenChange: (open: boolean) => void;
}

function RailRow({ icon, label, name, current, onClick }: {
  readonly icon: IconName;
  readonly label: string;
  readonly name?: string;
  readonly current?: boolean;
  readonly onClick: () => void;
}) {
  const content = <><Icon name={icon} />{label}</>;
  const aria = { ...(current ? { 'aria-current': 'page' as const } : {}), ...(name ? { 'aria-label': name, title: name } : {}) };
  return <button className="rail-link" type="button" onClick={onClick} {...aria}>{content}</button>;
}

/** Navigation tree shared by the fixed desktop rail and the mobile drawer. `afterAction` closes the drawer once a row has run. */
function RailContent({ tool, recoveryOpen, showConversation, onNewGame, onBoard, onTool, onDownload, onAccount, afterAction }: Omit<Props, 'menuOpen' | 'onMenuOpenChange'> & { readonly afterAction?: () => void }) {
  const run = (action: () => void) => () => { action(); afterAction?.(); };
  return <>
    <button className="button primary rail-new" type="button" onClick={run(onNewGame)}><Icon name="plus" />New game</button>
    <nav className="rail-nav" aria-label="Game navigation">
      <RailRow icon="board" label="Board" current={tool === null && !recoveryOpen} onClick={run(onBoard)} />
      {showConversation && <RailRow icon="bot" label="Model conversation" current={tool === 'archive'} onClick={run(() => onTool('archive'))} />}
    </nav>
    <div className="rail-bottom">
      <RailRow icon="download" label="Download game" name="Download game (JSON)" onClick={run(onDownload)} />
      <RailRow icon="settings" label="Settings" current={tool === 'settings'} onClick={run(() => onTool('settings'))} />
      {onAccount && <RailRow icon="account" label="Account" onClick={run(onAccount)} />}
    </div>
  </>;
}

/** The game's left navigation: a fixed rail on wide screens, and a drawer opened from the topbar menu button below 1001px. */
export function LeftGameRail({ menuOpen, onMenuOpenChange, ...rail }: Props) {
  const returnFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (menuOpen && !wasOpen.current) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    wasOpen.current = menuOpen;
  }, [menuOpen]);
  return <>
    <aside className="game-rail" aria-label="Main sidebar"><a className="wordmark" href="/">kamkm chess</a><RailContent {...rail} /></aside>
    <Dialog.Root open={menuOpen} onOpenChange={onMenuOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="game-rail-backdrop" />
        <Dialog.Popup className="game-rail-drawer" finalFocus={() => returnFocus.current?.isConnected ? returnFocus.current : false}>
          <header className="rail-drawer-heading"><Dialog.Title>Menu</Dialog.Title><IconButton icon="close" label="Close menu" onClick={() => onMenuOpenChange(false)} /></header>
          <RailContent {...rail} afterAction={() => onMenuOpenChange(false)} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  </>;
}
