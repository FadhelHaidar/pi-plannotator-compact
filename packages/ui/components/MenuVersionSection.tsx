import React from 'react';

// Fork-specific: the upstream release feed is a different product, so this
// section links the fork's own repo instead of checking for "new versions".
const REPO_URL = 'https://github.com/FadhelHaidar/pi-plannotator-compact';

interface MenuVersionSectionProps {
  appVersion: string;
  closeMenu: () => void;
}

export const MenuVersionSection: React.FC<MenuVersionSectionProps> = ({
  appVersion,
  closeMenu,
}) => {
  return (
    <div className="px-3 py-2 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={closeMenu}
          className="text-[10px] font-semibold tracking-wide text-muted-foreground hover:text-foreground transition-colors"
        >
          Plannotator
        </a>
        <span className="text-[10px] font-mono text-muted-foreground/70">
          v{appVersion}
        </span>
      </div>
      <div className="flex flex-col items-start gap-1 text-[11px]">
        <a
          href={`${REPO_URL}/releases`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={closeMenu}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          Release notes
        </a>
      </div>
    </div>
  );
};
