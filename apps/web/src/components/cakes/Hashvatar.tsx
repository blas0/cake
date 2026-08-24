import { Hashvatar as HashvatarCanvas } from "hashvatar/react";

import { cn } from "~/lib/utils";

import { cakeAvatarHash } from "./cakeIdentity.ts";

/**
 * A cake's face.
 *
 * The one custom primitive in this feature — everything else uses the existing
 * design system. It wraps the `hashvatar` package rather than reimplementing
 * it, so the avatars match the reference the feature was specified against and
 * stay correct if that package improves.
 *
 * Derived from the cake's id rather than its name, so renaming a cake does not
 * change how it is recognised. See `cakeIdentity.ts`.
 *
 * Dithered and animated by default, because a cake is a thing that keeps
 * running on its own and the face that stands for it should read as alive.
 * Both stay props, so a surface that wants a still face can ask for one.
 *
 * The animation is a canvas render loop. `hashvatar/react` starts it inside an
 * effect and returns the package's own `destroy` as that effect's cleanup, so
 * unmounting a list of cakes stops every loop it started; nothing here needs to
 * repeat that.
 */
export function CakeHashvatar({
  cake,
  size = 24,
  mode = "dither",
  animated = true,
  className,
}: {
  readonly cake: { readonly id: string; readonly name: string };
  readonly size?: number;
  readonly mode?: "gradient" | "dither";
  readonly animated?: boolean;
  readonly className?: string;
}): React.JSX.Element {
  return (
    // The canvas takes no ARIA of its own, so the label lives on a wrapper.
    // A screen reader should say which cake this is, not read out a hash.
    <span role="img" aria-label={cake.name} className={cn("inline-flex shrink-0", className)}>
      <HashvatarCanvas
        hash={cakeAvatarHash(cake)}
        size={size}
        mode={mode}
        animated={animated}
        className="rounded-full"
      />
    </span>
  );
}
