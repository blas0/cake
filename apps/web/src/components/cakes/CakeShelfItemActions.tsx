"use client";

import { EllipsisIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

interface CakeShelfActionCallbacks {
  readonly onRename: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}

export function CakeShelfActionTriggerButton({
  cakeName,
  onPointerDown,
  ...props
}: { readonly cakeName: string } & ComponentProps<typeof Button>) {
  return (
    <Button
      {...props}
      type="button"
      size="icon-xs"
      variant="ghost-muted"
      aria-label={`Actions for ${cakeName}`}
      onPointerDown={(event) => {
        event.stopPropagation();
        onPointerDown?.(event);
      }}
    />
  );
}

export function CakeShelfActionMenuItems({ onRename, onEdit, onDelete }: CakeShelfActionCallbacks) {
  return (
    <>
      <MenuItem onClick={onRename}>Rename</MenuItem>
      <MenuItem onClick={onEdit}>Edit</MenuItem>
      <MenuItem variant="destructive" onClick={onDelete}>
        Delete
      </MenuItem>
    </>
  );
}

export function CakeShelfItemActions({
  cakeName,
  onRename,
  onEdit,
  onDelete,
}: CakeShelfActionCallbacks & { readonly cakeName: string }) {
  return (
    <Menu>
      <MenuTrigger render={<CakeShelfActionTriggerButton cakeName={cakeName} />}>
        <EllipsisIcon aria-hidden className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-32">
        <CakeShelfActionMenuItems onRename={onRename} onEdit={onEdit} onDelete={onDelete} />
      </MenuPopup>
    </Menu>
  );
}
