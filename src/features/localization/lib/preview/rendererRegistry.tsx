/**
 * rendererRegistry — single, deterministic dispatch surface that maps a
 * localization artefact + its declared output format to the preview
 * component that should render it. Consumed by both the split-pane
 * preview (`ReturnFormatPreview`, editor tabs) and the detached
 * pop-out window (`LocalizationPreviewWindow`), so there is one truth
 * about how each `(artefact, formatKind)` pair renders.
 *
 * Phase B of the localization preview consolidation
 * (see .lovable/plan.md). Later phases plug new renderers in here
 * without touching the consumers.
 */
import type { ReactElement } from "react";
import { AlertCircle } from "lucide-react";
import { CertificatePreviewPane } from "../../components/CertificatePreviewPane";
import { ReturnPreviewPane } from "../../components/ReturnPreviewPane";
import {
  SpreadsheetPreviewPane,
  type SpreadsheetPreviewProps,
} from "../../components/preview/SpreadsheetPreviewPane";
import {
  SerialisedPayloadPreview,
} from "../../components/preview/SerialisedPayloadPreview";
import {
  EntityInspectorPane,
  type EntityInspectorPaneProps,
} from "../../components/preview/EntityInspectorPane";
import type { PreviewKind, PreviewPayload } from "../previewBroadcast";

export type ReturnFormatKind = "csv" | "xlsx" | "xml" | "json" | "pdf";

export interface ReturnRendererInput {
  templateCode: string;
  displayName?: string | null;
  body: any;
  meta?: any;
  packId?: string | null;
  /** Precomputed spreadsheet props for tabular kinds. */
  spreadsheetProps?: SpreadsheetPreviewProps;
}

export interface ReturnRendererDescriptor {
  /** Stable id — used in telemetry, tests, and ESLint guards. */
  id: string;
  formatKind: ReturnFormatKind;
  render: (input: ReturnRendererInput) => ReactElement;
}

/**
 * Resolve the descriptor for a statutory-return template. Callers pass
 * the already-computed `formatKind` (from `meta.submission_format.kind`
 * with the CSV default applied) — the registry only picks the
 * component, it does NOT re-derive the format.
 */
export function resolveReturnRenderer(formatKind: ReturnFormatKind): ReturnRendererDescriptor {
  switch (formatKind) {
    case "csv":
    case "xlsx":
      return {
        id: `return/${formatKind}`,
        formatKind,
        render: ({ spreadsheetProps }) => (
          <SpreadsheetPreviewPane {...(spreadsheetProps as SpreadsheetPreviewProps)} />
        ),
      };
    case "xml":
    case "json":
      return {
        id: `return/${formatKind}`,
        formatKind,
        render: ({ body, meta }) => (
          <SerialisedPayloadPreview body={body} meta={meta} kind={formatKind} />
        ),
      };
    case "pdf":
    default:
      // PDF returns render through the shared HTML + paged.js pipeline
      // (see returnToAst → CertificateHtmlSurface). pdf-lib is banned
      // from localization code — see ESLint rule.
      return {
        id: "return/pdf",
        formatKind: "pdf",
        render: ({ templateCode, displayName, body, meta }) => (
          <ReturnPreviewPane
            templateCode={templateCode}
            displayName={displayName ?? templateCode}
            body={body}
            meta={meta}
          />
        ),
      };
  }
}

/**
 * Resolve the pop-out preview surface for a broadcast payload. The
 * single dispatch point for the detached preview window — replaces the
 * ad-hoc switch in `LocalizationPreviewWindow`.
 */
export function resolvePopOutRenderer(kind: PreviewKind, payload: PreviewPayload): ReactElement {
  switch (kind) {
    case "certificate":
      return (
        <CertificatePreviewPane
          templateCode={payload.templateCode}
          displayName={payload.displayName ?? payload.templateCode}
          body={payload.body}
          meta={payload.meta as any}
        />
      );
    case "return": {
      const meta = (payload.meta ?? {}) as { submission_format?: { kind?: ReturnFormatKind } };
      const body = payload.body as any;
      const declared = meta.submission_format?.kind ?? null;
      const formatKind: ReturnFormatKind = declared ?? "csv";
      const descriptor = resolveReturnRenderer(formatKind);
      return descriptor.render({
        templateCode: payload.templateCode,
        displayName: payload.displayName,
        body,
        meta,
      });
    }
    case "bank-export":
    case "garnishment":
    case "token-registry":
      return <SpreadsheetPreviewPane {...(payload.body as SpreadsheetPreviewProps)} />;
    case "statutory-authority":
    case "pack-requirements":
    case "publisher-governance":
      return <EntityInspectorPane {...(payload.body as EntityInspectorPaneProps)} />;
    default:
      return (
        <div className="flex h-full w-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
          <div className="flex flex-col items-center gap-2">
            <AlertCircle className="h-6 w-6 text-muted-foreground/60" />
            <p>No preview renderer registered for kind "{kind}".</p>
          </div>
        </div>
      );
  }
}

/** Human label for the resolved format — surfaced in the preview header strip. */
export function describeReturnFormat(formatKind: ReturnFormatKind): string {
  switch (formatKind) {
    case "csv": return "CSV — column export";
    case "xlsx": return "Excel workbook (.xlsx)";
    case "xml": return "XML payload";
    case "json": return "JSON payload";
    case "pdf": return "PDF — paper form";
  }
}
