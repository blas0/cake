/**
 * What a cake's avatar is derived from.
 *
 * The id, never the name. A cake's face is how it is recognised on the shelf
 * and in the fork dialog, and the name is the one field a
 * user edits casually — an avatar that shifted underneath a rename would teach
 * them the picture means nothing.
 */
export function cakeAvatarHash(cake: { readonly id: string; readonly name: string }): string {
  return `cake:${cake.id}`;
}
