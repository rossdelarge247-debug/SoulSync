/** The auto-mix lab is for admins, in a development build or with `?lab=1`. */
export function labAllowed(isAdmin: boolean, dev: boolean, search: string): boolean {
  return isAdmin && (dev || new URLSearchParams(search).has('lab'));
}
