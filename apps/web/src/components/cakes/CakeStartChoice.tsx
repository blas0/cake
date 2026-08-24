"use client";

import type { ReactNode } from "react";

import { Button } from "../ui/button";

export function CakeStartQuestion({
  cakeName,
  avatar,
}: {
  readonly cakeName: string;
  readonly avatar: ReactNode;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span>Start</span>
      <span aria-hidden>{avatar}</span>
      <span>{cakeName} now?</span>
    </span>
  );
}

export function CakeStartChoice({ onStart }: { readonly onStart: () => void }) {
  return <Button onClick={onStart}>Start now</Button>;
}
