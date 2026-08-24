import { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { memo, type ReactNode } from "react";
import { EllipsisIcon, OctagonXIcon } from "lucide-react";
import { runningCakeEntry } from "../cakes/cakeThreadModel";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { COMPOSER_CAKE_STATUS_LABEL, type ComposerCakesModel } from "./ComposerCakeControls";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  showInteractionModeToggle: boolean;
  traitsMenuContent?: ReactNode;
  /**
   * Null when no cake is attached to this thread. The narrow footer hides the
   * two cake controls behind this menu, so leaving them out here would make
   * the feature unreachable on a small viewport rather than merely cramped.
   */
  cakes: ComposerCakesModel | null;
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const cakesModel = props.cakes !== null && props.cakes.entries.length > 0 ? props.cakes : null;
  const stoppableCake = cakesModel === null ? null : runningCakeEntry(cakesModel.entries);
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
            aria-label="More composer controls"
          />
        }
      >
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start">
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            <MenuDivider />
          </>
        ) : null}
        {props.showInteractionModeToggle ? (
          <>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
            <MenuRadioGroup
              value={props.interactionMode}
              onValueChange={(value) => {
                if (!value || value === props.interactionMode) return;
                props.onToggleInteractionMode();
              }}
            >
              <MenuRadioItem value="default">Chat</MenuRadioItem>
              <MenuRadioItem value="plan">Plan</MenuRadioItem>
            </MenuRadioGroup>
            <MenuDivider />
          </>
        ) : null}
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
        <MenuRadioGroup
          value={props.runtimeMode}
          onValueChange={(value) => {
            if (!value || value === props.runtimeMode) return;
            props.onRuntimeModeChange(value as RuntimeMode);
          }}
        >
          <MenuRadioItem value="approval-required">Supervised</MenuRadioItem>
          <MenuRadioItem value="auto-accept-edits">Auto-accept edits</MenuRadioItem>
          <MenuRadioItem value="auto">Auto</MenuRadioItem>
          <MenuRadioItem value="full-access">Full access</MenuRadioItem>
        </MenuRadioGroup>
        {cakesModel === null ? null : (
          <>
            <MenuDivider />
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Cakes</div>
            {cakesModel.entries.map((entry) => (
              <MenuCheckboxItem
                key={entry.cakeId}
                variant="switch"
                checked={entry.enabled}
                onCheckedChange={(checked) => {
                  cakesModel.onSetCakeEnabled(entry.cakeId, checked);
                }}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{entry.name}</span>
                  <span className="text-muted-foreground text-xs leading-4">
                    {COMPOSER_CAKE_STATUS_LABEL[entry.status]}
                  </span>
                </span>
              </MenuCheckboxItem>
            ))}
            {stoppableCake === null ? null : (
              <MenuItem variant="destructive" onClick={cakesModel.onStopCake}>
                <OctagonXIcon />
                Stop Cake
              </MenuItem>
            )}
          </>
        )}
      </MenuPopup>
    </Menu>
  );
});
