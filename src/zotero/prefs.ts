import { config } from "../../package.json";

const PREFIX = config.prefsPrefix;

export function getPref(key: string): string | number | boolean | undefined {
  return Zotero.Prefs.get(`${PREFIX}.${key}`, true) as any;
}

export function setPref(key: string, value: string | number | boolean) {
  Zotero.Prefs.set(`${PREFIX}.${key}`, value, true);
}
