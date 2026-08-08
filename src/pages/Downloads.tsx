/**
 * Downloads — the native surfaces page.
 *
 * Replaces the old `/install` PWA page. The browser already handles
 * progressive-web-app installation on its own; what operators actually
 * need to discover is:
 *
 *   1. AccrualFlow Desktop (Electron) — Windows / macOS / Linux, with
 *      direct USB, serial, Bluetooth and network access to POS hardware.
 *   2. AccrualFlow Edge Agent — a tiny local service for teams that keep
 *      running the app in the browser but still need real hardware.
 *   3. The browser itself — zero install, full accounting.
 *
 * This page is intentionally marketing-grade: it is the first thing a
 * prospect sees when they wonder "can this actually drive my thermal
 * printer and cash drawer?".
 */

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Apple,
  ArrowRight,
  BadgeCheck,
  Barcode,
  Check,
  Cpu,
  Download,
  Globe,
  HardDrive,
  Laptop,
  Lock,
  Minus,
  Monitor,
  Printer,
  Radio,
  RefreshCw,
  Scale,
  ShieldCheck,
  Terminal,
  Usb,
  Wifi,
  Zap,
} from "lucide-react";

import { LandingHeader } from "@/components/landing/LandingHeader";
import { FooterSection } from "@/components/landing/CTASection";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Release metadata                                                    */
/* ------------------------------------------------------------------ */

const DESKTOP_VERSION = "1.0.0";
const AGENT_VERSION = "1.0.0";
const RELEASE_BASE = "https://downloads.accrualflow.systems";

type PlatformKey = "windows" | "mac" | "linux";

interface DesktopBuild {
  key: PlatformKey;
  name: string;
  icon: typeof Monitor;
  requirement: string;
  primary: { label: string; file: string; size: string };
  secondary: { label: string; file: string; size: string }[];
}

const DESKTOP_BUILDS: DesktopBuild[] = [
  {
    key: "windows",
    name: "Windows",
    icon: Monitor,
    requirement: "Windows 10 / 11 · 64-bit",
    primary: {
      label: "Download installer (.exe)",
      file: `AccrualFlow-Setup-${DESKTOP_VERSION}.exe`,
      size: "96 MB",
    },
    secondary: [
      { label: "Portable build", file: `AccrualFlow-${DESKTOP_VERSION}-portable.exe`, size: "94 MB" },
    ],
  },
  {
    key: "mac",
    name: "macOS",
    icon: Apple,
    requirement: "macOS 12 Monterey or later",
    primary: {
      label: "Download for Apple Silicon (.dmg)",
      file: `AccrualFlow-${DESKTOP_VERSION}-arm64.dmg`,
      size: "102 MB",
    },
    secondary: [
      { label: "Intel build (.dmg)", file: `AccrualFlow-${DESKTOP_VERSION}-x64.dmg`, size: "106 MB" },
    ],
  },
  {
    key: "linux",
    name: "Linux",
    icon: Terminal,
    requirement: "Ubuntu 20.04+ · Fedora · Debian",
    primary: {
      label: "Download AppImage",
      file: `AccrualFlow-${DESKTOP_VERSION}.AppImage`,
      size: "108 MB",
    },
    secondary: [
      { label: "Debian package (.deb)", file: `accrualflow_${DESKTOP_VERSION}_amd64.deb`, size: "99 MB" },
    ],
  },
];

const AGENT_BUILDS: { key: PlatformKey; label: string; file: string }[] = [
  { key: "windows", label: "Windows service", file: `AccrualFlow-Edge-Agent-${AGENT_VERSION}.msi` },
  { key: "mac", label: "macOS daemon", file: `accrualflow-edge-agent-${AGENT_VERSION}.pkg` },
  { key: "linux", label: "Linux (systemd)", file: `accrualflow-edge-agent-${AGENT_VERSION}.tar.gz` },
];

const HARDWARE = [
  { icon: Printer, label: "Thermal receipt printers", detail: "ESC/POS · USB, serial, network, CUPS" },
  { icon: Barcode, label: "Label printers", detail: "ZPL · Zebra, TSC, Godex" },
  { icon: HardDrive, label: "Cash drawers", detail: "Kick-out via printer or direct" },
  { icon: Scale, label: "Weighing scales", detail: "Serial protocol, live weight capture" },
  { icon: Usb, label: "Barcode scanners", detail: "USB HID, serial and Bluetooth" },
  { icon: Radio, label: "Payment terminals", detail: "Cloud and local terminal drivers" },
];

interface MatrixRow {
  capability: string;
  desktop: boolean | string;
  agent: boolean | string;
  browser: boolean | string;
}

const MATRIX: MatrixRow[] = [
  { capability: "Full accounting, POS, inventory, payroll", desktop: true, agent: true, browser: true },
  { capability: "Direct USB / serial printer control", desktop: true, agent: true, browser: false },
  { capability: "Cash drawer kick & scale reading", desktop: true, agent: true, browser: false },
  { capability: "Bluetooth device pairing", desktop: true, agent: "Partial", browser: false },
  { capability: "Silent receipt printing (no dialog)", desktop: true, agent: true, browser: false },
  { capability: "Offline register with encrypted local cache", desktop: true, agent: "Browser cache", browser: "Browser cache" },
  { capability: "Runs without installing anything", desktop: false, agent: false, browser: true },
  { capability: "Automatic background updates", desktop: true, agent: true, browser: true },
];

const FAQS = [
  {
    q: "Do I have to install anything to use AccrualFlow?",
    a: "No. Every accounting, sales, inventory and payroll workflow runs in the browser. Desktop and the Edge Agent exist purely to unlock local hardware — receipt printers, cash drawers, scales, scanners and payment terminals — which browsers are not allowed to touch directly.",
  },
  {
    q: "What is the difference between Desktop and the Edge Agent?",
    a: "Desktop is the whole application in a native shell: it owns the window, the hardware and an encrypted offline cache. The Edge Agent is a small background service that only brokers hardware. Choose Desktop for lanes and counters; choose the Agent when your team must stay in Chrome or on managed machines where a full app install is not permitted.",
  },
  {
    q: "Can one Edge Agent serve several workstations?",
    a: "Yes. Agents enrol against a workstation identity and expose their devices to any authorised browser session on the same site, so a back-office printer can be shared by the whole floor.",
  },
  {
    q: "How are updates delivered?",
    a: "Desktop and the Agent both check for signed updates on launch and apply them in the background. Your data never lives only on the device — it syncs to your tenant continuously and reconciles after any offline period.",
  },
  {
    q: "Is the hardware bridge secure?",
    a: "Each device session is wrapped in a signed envelope bound to the enrolled workstation, commands are nonce-protected, and the agent listens only on localhost. Nothing on your network can drive your hardware without an authenticated session.",
  },
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function detectPlatform(): PlatformKey {
  if (typeof navigator === "undefined") return "windows";
  const ua = `${navigator.userAgent} ${navigator.platform ?? ""}`.toLowerCase();
  if (ua.includes("mac")) return "mac";
  if (ua.includes("linux") || ua.includes("x11")) return "linux";
  return "windows";
}

const fade = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0 },
};

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function Downloads() {
  const [platform, setPlatform] = useState<PlatformKey>("windows");

  useEffect(() => {
    setPlatform(detectPlatform());
    document.title = "Download AccrualFlow Desktop & Edge Agent";
  }, []);

  const recommended = useMemo(
    () => DESKTOP_BUILDS.find((b) => b.key === platform) ?? DESKTOP_BUILDS[0],
    [platform],
  );

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <LandingHeader />

      {/* ---------------------------------------------------------- */}
      {/* Hero                                                        */}
      {/* ---------------------------------------------------------- */}
      <section className="relative overflow-hidden pt-32 pb-20">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -top-40 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-purple-600/25 blur-[140px]" />
          <div className="absolute top-40 right-0 h-[420px] w-[420px] rounded-full bg-cyan-500/20 blur-[140px]" />
          <div
            className="absolute inset-0 opacity-[0.07]"
            style={{
              backgroundImage:
                "linear-gradient(to right, white 1px, transparent 1px), linear-gradient(to bottom, white 1px, transparent 1px)",
              backgroundSize: "64px 64px",
              maskImage: "radial-gradient(ellipse at 50% 0%, black 40%, transparent 75%)",
            }}
          />
        </div>

        <div className="container relative mx-auto max-w-6xl px-4">
          <motion.div
            initial="hidden"
            animate="show"
            variants={fade}
            transition={{ duration: 0.6 }}
            className="mx-auto max-w-3xl text-center"
          >
            <Badge className="mb-6 border-white/15 bg-white/5 px-4 py-1.5 text-xs font-medium tracking-widest text-cyan-300 uppercase hover:bg-white/5">
              Native surfaces · v{DESKTOP_VERSION}
            </Badge>
            <h1 className="text-4xl font-bold leading-[1.05] tracking-tight sm:text-6xl">
              Your books in the cloud.
              <br />
              <span className="bg-gradient-to-r from-purple-400 via-fuchsia-400 to-cyan-400 bg-clip-text text-transparent">
                Your hardware on the counter.
              </span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg text-white/60">
              AccrualFlow Desktop drives thermal printers, cash drawers, scales, scanners and
              payment terminals natively — no drivers to babysit, no print dialogs, no browser
              limits. Prefer the browser? Install the Edge Agent instead and keep the same hardware.
            </p>

            <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Button
                size="lg"
                className="h-14 gap-3 border-0 bg-gradient-to-r from-purple-500 to-cyan-500 px-8 text-base font-semibold text-white shadow-[0_20px_60px_-15px_rgba(168,85,247,0.6)] hover:from-purple-600 hover:to-cyan-600"
                asChild
              >
                <a href={`${RELEASE_BASE}/desktop/${recommended.primary.file}`}>
                  <Download className="h-5 w-5" />
                  Download for {recommended.name}
                  <span className="text-white/70">· {recommended.primary.size}</span>
                </a>
              </Button>
              <Button
                size="lg"
                variant="ghost"
                className="h-14 gap-2 border border-white/20 px-6 text-base text-white hover:bg-white/10 hover:text-white"
                asChild
              >
                <a href="#agent">
                  <Cpu className="h-5 w-5" />
                  I'd rather stay in the browser
                </a>
              </Button>
            </div>

            <p className="mt-5 text-sm text-white/40">
              {recommended.requirement} · Signed build · Free with every AccrualFlow plan
            </p>
          </motion.div>

          {/* Trust strip */}
          <motion.div
            initial="hidden"
            animate="show"
            variants={fade}
            transition={{ duration: 0.6, delay: 0.15 }}
            className="mx-auto mt-16 grid max-w-4xl grid-cols-2 gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 sm:grid-cols-4"
          >
            {[
              { icon: ShieldCheck, label: "Signed & notarised" },
              { icon: Zap, label: "Sub-second printing" },
              { icon: Wifi, label: "Works offline" },
              { icon: RefreshCw, label: "Auto-updating" },
            ].map((item) => (
              <div key={item.label} className="flex items-center gap-3 bg-slate-950 px-5 py-5">
                <item.icon className="h-5 w-5 shrink-0 text-cyan-400" />
                <span className="text-sm text-white/70">{item.label}</span>
              </div>
            ))}
          </motion.div>
        </div>
      </section>

      {/* ---------------------------------------------------------- */}
      {/* Desktop builds                                              */}
      {/* ---------------------------------------------------------- */}
      <section id="desktop" className="relative border-t border-white/10 py-24">
        <div className="container mx-auto max-w-6xl px-4">
          <div className="mb-14 max-w-2xl">
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-purple-400">
              AccrualFlow Desktop
            </p>
            <h2 className="text-3xl font-bold sm:text-4xl">One app. Every platform.</h2>
            <p className="mt-4 text-white/60">
              The complete platform in a native shell, with an encrypted local cache so a lane keeps
              selling through an internet outage and reconciles the moment it returns.
            </p>
          </div>

          <div className="grid gap-6 md:grid-cols-3">
            {DESKTOP_BUILDS.map((build, i) => {
              const isRecommended = build.key === platform;
              return (
                <motion.div
                  key={build.key}
                  initial="hidden"
                  whileInView="show"
                  viewport={{ once: true, margin: "-80px" }}
                  variants={fade}
                  transition={{ duration: 0.5, delay: i * 0.08 }}
                  className={cn(
                    "group relative flex flex-col rounded-2xl border p-7 transition-colors",
                    isRecommended
                      ? "border-purple-400/40 bg-gradient-to-b from-purple-500/10 to-transparent"
                      : "border-white/10 bg-white/[0.03] hover:border-white/20",
                  )}
                >
                  {isRecommended && (
                    <span className="absolute -top-3 left-7 rounded-full bg-gradient-to-r from-purple-500 to-cyan-500 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-white">
                      Detected
                    </span>
                  )}
                  <build.icon className="h-8 w-8 text-white/80" />
                  <h3 className="mt-5 text-xl font-semibold">{build.name}</h3>
                  <p className="mt-1 text-sm text-white/45">{build.requirement}</p>

                  <div className="mt-6 flex-1" />

                  <Button
                    className="w-full justify-center gap-2 border-0 bg-white text-slate-900 hover:bg-white/90"
                    asChild
                  >
                    <a href={`${RELEASE_BASE}/desktop/${build.primary.file}`}>
                      <Download className="h-4 w-4" />
                      {build.primary.label}
                    </a>
                  </Button>
                  <p className="mt-2 text-center text-xs text-white/35">
                    {build.primary.size} · v{DESKTOP_VERSION}
                  </p>

                  <div className="mt-4 space-y-1 border-t border-white/10 pt-4">
                    {build.secondary.map((alt) => (
                      <a
                        key={alt.file}
                        href={`${RELEASE_BASE}/desktop/${alt.file}`}
                        className="flex items-center justify-between rounded-lg px-2 py-1.5 text-sm text-white/55 transition-colors hover:bg-white/5 hover:text-white"
                      >
                        <span>{alt.label}</span>
                        <span className="text-xs text-white/30">{alt.size}</span>
                      </a>
                    ))}
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------- */}
      {/* Hardware grid                                               */}
      {/* ---------------------------------------------------------- */}
      <section className="border-t border-white/10 bg-white/[0.02] py-24">
        <div className="container mx-auto max-w-6xl px-4">
          <div className="mb-14 max-w-2xl">
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-cyan-400">
              Hardware
            </p>
            <h2 className="text-3xl font-bold sm:text-4xl">The counter, fully wired.</h2>
            <p className="mt-4 text-white/60">
              Discovery, pairing, health checks and diagnostics for every peripheral on the lane —
              managed from the same console your finance team already uses.
            </p>
          </div>

          <div className="grid gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 sm:grid-cols-2 lg:grid-cols-3">
            {HARDWARE.map((h) => (
              <div key={h.label} className="bg-slate-950 p-7">
                <h.icon className="h-6 w-6 text-purple-400" />
                <h3 className="mt-4 font-semibold">{h.label}</h3>
                <p className="mt-1 text-sm text-white/45">{h.detail}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------- */}
      {/* Edge Agent                                                  */}
      {/* ---------------------------------------------------------- */}
      <section id="agent" className="relative overflow-hidden border-t border-white/10 py-24">
        <div className="pointer-events-none absolute -right-20 top-20 h-[380px] w-[380px] rounded-full bg-cyan-500/15 blur-[130px]" />
        <div className="container relative mx-auto max-w-6xl px-4">
          <div className="grid items-center gap-14 lg:grid-cols-2">
            <div>
              <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-cyan-400">
                AccrualFlow Edge Agent
              </p>
              <h2 className="text-3xl font-bold sm:text-4xl">
                Stay in the browser. Keep the hardware.
              </h2>
              <p className="mt-4 text-white/60">
                A ~12 MB background service that enrols one workstation, exposes its devices over a
                signed local channel and disappears into the tray. Ideal for locked-down fleets,
                shared back offices and teams that simply prefer a tab.
              </p>

              <ul className="mt-8 space-y-3">
                {[
                  "Installs as a Windows service, launchd daemon or systemd unit",
                  "Listens on localhost only — signed, nonce-protected sessions",
                  "Shares one printer or scale across every authorised browser session",
                  "Live device discovery, test prints and streaming diagnostic logs",
                ].map((point) => (
                  <li key={point} className="flex gap-3 text-sm text-white/70">
                    <BadgeCheck className="mt-0.5 h-4 w-4 shrink-0 text-cyan-400" />
                    {point}
                  </li>
                ))}
              </ul>

              <div className="mt-9 flex flex-wrap gap-3">
                {AGENT_BUILDS.map((a) => (
                  <Button
                    key={a.key}
                    variant="ghost"
                    className="gap-2 border border-white/20 text-white hover:bg-white/10 hover:text-white"
                    asChild
                  >
                    <a href={`${RELEASE_BASE}/agent/${a.file}`}>
                      <Download className="h-4 w-4" />
                      {a.label}
                    </a>
                  </Button>
                ))}
              </div>
              <p className="mt-4 text-xs text-white/35">Edge Agent v{AGENT_VERSION} · signed builds</p>
            </div>

            <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-1 shadow-2xl">
              <div className="flex items-center gap-2 px-4 py-3">
                <span className="h-2.5 w-2.5 rounded-full bg-red-400/70" />
                <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" />
                <span className="ml-2 text-xs text-white/40">edge-agent · workstation-01</span>
              </div>
              <div className="space-y-3 rounded-xl bg-slate-950/80 p-5 font-mono text-[13px]">
                {[
                  { s: "ok", t: "Epson TM-T88VI", d: "USB · receipt · ready" },
                  { s: "ok", t: "Zebra ZD421", d: "Network · labels · ready" },
                  { s: "ok", t: "Cash drawer", d: "Kick-out via TM-T88VI" },
                  { s: "warn", t: "CAS PD-II scale", d: "Serial · calibrating" },
                  { s: "ok", t: "Honeywell 1900", d: "HID · scanner · ready" },
                ].map((row) => (
                  <div key={row.t} className="flex items-center gap-3">
                    <span
                      className={cn(
                        "h-2 w-2 shrink-0 rounded-full",
                        row.s === "ok" ? "bg-emerald-400" : "bg-amber-400",
                      )}
                    />
                    <span className="text-white/85">{row.t}</span>
                    <span className="ml-auto truncate text-white/35">{row.d}</span>
                  </div>
                ))}
                <div className="border-t border-white/10 pt-3 text-white/40">
                  <span className="text-emerald-400">✓</span> 5 devices online · latency 4 ms
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------- */}
      {/* Comparison matrix                                           */}
      {/* ---------------------------------------------------------- */}
      <section className="border-t border-white/10 bg-white/[0.02] py-24">
        <div className="container mx-auto max-w-5xl px-4">
          <div className="mb-12 text-center">
            <h2 className="text-3xl font-bold sm:text-4xl">Which one do I need?</h2>
            <p className="mx-auto mt-4 max-w-xl text-white/60">
              Every surface runs the same platform and the same books. The only difference is how
              close you sit to the hardware.
            </p>
          </div>

          <div className="overflow-hidden rounded-2xl border border-white/10">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-white/10 bg-white/[0.04]">
                  <th className="p-5 font-medium text-white/50">Capability</th>
                  <th className="p-5 text-center">
                    <span className="flex items-center justify-center gap-2 font-semibold">
                      <Laptop className="h-4 w-4 text-purple-400" /> Desktop
                    </span>
                  </th>
                  <th className="p-5 text-center">
                    <span className="flex items-center justify-center gap-2 font-semibold">
                      <Cpu className="h-4 w-4 text-cyan-400" /> Edge Agent
                    </span>
                  </th>
                  <th className="p-5 text-center">
                    <span className="flex items-center justify-center gap-2 font-semibold">
                      <Globe className="h-4 w-4 text-white/60" /> Browser
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {MATRIX.map((row) => (
                  <tr key={row.capability} className="border-b border-white/5 last:border-0">
                    <td className="p-5 text-white/75">{row.capability}</td>
                    {([row.desktop, row.agent, row.browser] as const).map((cell, idx) => (
                      <td key={idx} className="p-5 text-center">
                        {cell === true ? (
                          <Check className="mx-auto h-4 w-4 text-emerald-400" />
                        ) : cell === false ? (
                          <Minus className="mx-auto h-4 w-4 text-white/20" />
                        ) : (
                          <span className="text-xs text-white/45">{cell}</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-6 flex items-center justify-center gap-2 text-center text-sm text-white/45">
            <Lock className="h-4 w-4" />
            Nothing here changes your data model — the same tenant, the same ledger, everywhere.
          </p>
        </div>
      </section>

      {/* ---------------------------------------------------------- */}
      {/* FAQ                                                         */}
      {/* ---------------------------------------------------------- */}
      <section className="border-t border-white/10 py-24">
        <div className="container mx-auto max-w-3xl px-4">
          <h2 className="mb-10 text-center text-3xl font-bold sm:text-4xl">Questions, answered</h2>
          <Accordion type="single" collapsible className="space-y-3">
            {FAQS.map((f, i) => (
              <AccordionItem
                key={f.q}
                value={`item-${i}`}
                className="rounded-xl border border-white/10 bg-white/[0.03] px-5"
              >
                <AccordionTrigger className="text-left text-base hover:no-underline">
                  {f.q}
                </AccordionTrigger>
                <AccordionContent className="text-white/60">{f.a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </section>

      {/* ---------------------------------------------------------- */}
      {/* Closing CTA                                                 */}
      {/* ---------------------------------------------------------- */}
      <section className="border-t border-white/10 py-24">
        <div className="container mx-auto max-w-5xl px-4">
          <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-purple-600/20 via-slate-900 to-cyan-600/20 p-12 text-center">
            <div className="pointer-events-none absolute inset-0 opacity-20 [background-image:radial-gradient(circle_at_20%_20%,white,transparent_35%),radial-gradient(circle_at_80%_60%,white,transparent_35%)]" />
            <div className="relative">
              <h2 className="text-3xl font-bold sm:text-4xl">Set up a lane in under five minutes.</h2>
              <p className="mx-auto mt-4 max-w-xl text-white/65">
                Create your workspace, download the surface that fits your counter, and print your
                first receipt today.
              </p>
              <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
                <Button
                  size="lg"
                  className="h-13 gap-2 border-0 bg-white px-8 font-semibold text-slate-900 hover:bg-white/90"
                  asChild
                >
                  <Link to="/signup">
                    Start free <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
                <Button
                  size="lg"
                  variant="ghost"
                  className="h-13 border border-white/25 px-8 text-white hover:bg-white/10 hover:text-white"
                  asChild
                >
                  <Link to="/contact">Talk to us about hardware</Link>
                </Button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <FooterSection />
    </div>
  );
}
