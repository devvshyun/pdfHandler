/**
 * Document-level sanitising: removes hidden information that is not page content (document
 * properties, XMP, scripts, attachments, bookmarks). Each part is optional.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFObject, PDFRef, PDFStream } from 'pdf-lib';

export interface SanitizeOptions {
  removeMetadata?: boolean;
  removeXmp?: boolean;
  removeJavaScript?: boolean;
  removeEmbeddedFiles?: boolean;
  removeOutlines?: boolean;
}

export interface SanitizeReport {
  /** Keys removed from the document information dictionary. */
  metadataKeys: string[];
  /** XMP metadata streams unlinked. */
  xmpStreams: number;
  /** Document scripts and JavaScript actions removed. */
  javaScripts: number;
  /** Embedded files and file attachment annotations removed. */
  embeddedFiles: number;
  /** Bookmark items removed. */
  outlineItems: number;
}

const N = (k: string) => PDFName.of(k);

export function sanitizeDocument(doc: PDFDocument, options: SanitizeOptions): SanitizeReport {
  const report: SanitizeReport = { metadataKeys: [], xmpStreams: 0, javaScripts: 0, embeddedFiles: 0, outlineItems: 0 };
  const { context, catalog } = doc;
  const on = (v: boolean | undefined) => v !== false;
  const names = catalog.lookup(N('Names'));

  if (on(options.removeMetadata)) {
    const info = context.lookup(context.trailerInfo.Info);
    if (info instanceof PDFDict) {
      for (const [k] of info.entries()) {
        report.metadataKeys.push(k.decodeText());
        info.delete(k);
      }
    }
  }

  if (on(options.removeJavaScript) && names instanceof PDFDict && names.has(N('JavaScript'))) {
    report.javaScripts += countNameTree(names.lookup(N('JavaScript')));
    names.delete(N('JavaScript'));
  }

  if (on(options.removeEmbeddedFiles)) {
    if (names instanceof PDFDict && names.has(N('EmbeddedFiles'))) {
      report.embeddedFiles += countNameTree(names.lookup(N('EmbeddedFiles')));
      names.delete(N('EmbeddedFiles'));
    }
    catalog.delete(N('Collection'));
    for (const page of doc.getPages()) {
      const annots = page.node.Annots();
      if (!annots) continue;
      const keep = annots.asArray().filter((_, i) => {
        const a = annots.lookup(i);
        const attachment = a instanceof PDFDict && a.get(N('Subtype')) === N('FileAttachment');
        if (attachment) report.embeddedFiles++;
        return !attachment;
      });
      if (keep.length !== annots.size()) page.node.set(N('Annots'), context.obj(keep));
    }
  }
  if (names instanceof PDFDict && names.entries().length === 0) catalog.delete(N('Names'));

  if (on(options.removeOutlines) && catalog.has(N('Outlines'))) {
    report.outlineItems = countOutlines(catalog.lookup(N('Outlines')));
    catalog.delete(N('Outlines'));
    if (catalog.get(N('PageMode')) === N('UseOutlines')) catalog.delete(N('PageMode'));
  }

  // Entries that can sit on any dictionary: walk every object once.
  const visit = (dict: PDFDict) => {
    if (on(options.removeXmp) && dict.has(N('Metadata'))) {
      const m = dict.lookup(N('Metadata'));
      if (m instanceof PDFStream) {
        dict.delete(N('Metadata'));
        report.xmpStreams++;
      }
    }
    if (on(options.removeEmbeddedFiles) && dict.has(N('AF'))) dict.delete(N('AF'));
    if (on(options.removeJavaScript)) {
      for (const k of ['OpenAction', 'A']) report.javaScripts += dropScripts(dict, N(k));
      const aa = dict.lookup(N('AA'));
      if (aa instanceof PDFDict) {
        for (const [k] of aa.entries()) report.javaScripts += dropScripts(aa, k);
        if (aa.entries().length === 0) dict.delete(N('AA'));
      }
    }
  };
  const walk = (obj: PDFObject) => {
    if (obj instanceof PDFStream) walk(obj.dict);
    else if (obj instanceof PDFDict) {
      visit(obj);
      for (const [, v] of obj.entries()) if (!(v instanceof PDFRef)) walk(v);
    } else if (obj instanceof PDFArray) {
      for (const v of obj.asArray()) if (!(v instanceof PDFRef)) walk(v);
    }
  };
  for (const [, obj] of context.enumerateIndirectObjects()) walk(obj);
  return report;
}

/**
 * Removes the JavaScript action at `dict[key]` (an action, or an array of actions), and script
 * actions chained after other actions through /Next; returns how many went.
 */
function dropScripts(dict: PDFDict | PDFArray, key: PDFName | number, depth = 0): number {
  if (depth > 32) return 0;
  const action = dict instanceof PDFDict ? dict.lookup(key as PDFName) : dict.lookup(key as number);
  const remove = () => (dict instanceof PDFDict ? dict.delete(key as PDFName) : dict.remove(key as number));
  if (action instanceof PDFArray) {
    let n = 0;
    for (let i = action.size() - 1; i >= 0; i--) n += dropScripts(action, i, depth + 1);
    if (action.size() === 0) remove();
    return n;
  }
  if (!(action instanceof PDFDict)) return 0;
  if (action.get(N('S')) === N('JavaScript') || action.has(N('JS'))) {
    // Actions chained after the script (cleaned of scripts themselves) take its place.
    const n = dropScripts(action, N('Next'), depth + 1);
    const next = action.get(N('Next'));
    if (!next) remove();
    else if (dict instanceof PDFDict) dict.set(key as PDFName, next);
    else dict.set(key as number, next);
    return 1 + n;
  }
  return dropScripts(action, N('Next'), depth + 1);
}

function countNameTree(node: PDFObject | undefined, depth = 0): number {
  if (!(node instanceof PDFDict) || depth > 32) return 0;
  const names = node.lookup(N('Names'));
  const kids = node.lookup(N('Kids'));
  let n = names instanceof PDFArray ? Math.floor(names.size() / 2) : 0;
  if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) n += countNameTree(kids.lookup(i), depth + 1);
  return n;
}

function countOutlines(root: PDFObject | undefined): number {
  const seen = new Set<PDFDict>();
  const count = (item: PDFObject | undefined): number => {
    let n = 0;
    while (item instanceof PDFDict && !seen.has(item)) {
      seen.add(item);
      n += 1 + count(item.lookup(N('First')));
      item = item.lookup(N('Next'));
    }
    return n;
  };
  return root instanceof PDFDict ? count(root.lookup(N('First'))) : 0;
}
