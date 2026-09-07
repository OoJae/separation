/**
 * Render the long-form docs into site pages.
 *
 * findings.html and notebook.html are GENERATED from docs/API-NOTES.md and docs/NOTEBOOK.md rather
 * than hand-written, because this project has already been bitten once by prose drifting away from
 * its source: the README's headline transcript named a clearance that existed in no run. Two copies
 * of one claim is one copy too many. The designed pages (index, theorem, architecture) stay
 * hand-written because they argue rather than document.
 *
 * A small renderer instead of a markdown dependency, for the same reason the scene is hand-rolled:
 * the repo ships two runtime dependencies and no build tooling, and that is worth keeping.
 */
import { readFileSync, writeFileSync } from "node:fs"

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

// Private-use codepoints, so a placeholder can never collide with document text.
const OPEN = ""
const SHUT = ""

/**
 * Inline spans. Code is lifted out first so nothing inside backticks is re-interpreted.
 *
 * The obvious placeholder scheme — swapping code spans for " 0 ", " 1 " — silently corrupts any
 * prose containing a bare number, and these documents are mostly numbers.
 */
function inline(s: string): string {
	const code: string[] = []
	let t = s.replace(/`([^`]+)`/g, (_m, c: string) => OPEN + (code.push(c) - 1) + SHUT)
	t = esc(t)
	t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, href: string) => '<a href="' + href + '">' + label + "</a>")
	t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
	t = t.replace(/(^|[\s(])\*([^*]+)\*/g, "$1<em>$2</em>")
	return t.replace(new RegExp(OPEN + "(\\d+)" + SHUT, "g"),
		(_m, i: string) => "<code>" + esc(code[Number(i)] ?? "") + "</code>")
}

/**
 * Does this line open a block? Shared by the dispatcher and the paragraph scanner.
 *
 * When those two disagreed, the scanner could refuse every line of a paragraph while the dispatcher
 * refused to handle it, so the cursor never advanced and the renderer hung until it exhausted the
 * heap. The disagreement was a loose `/^#/` guard: a line reading "#113" is an issue reference, not
 * a heading, and these documents are full of them.
 */
function opensBlock(line: string): boolean {
	return line.startsWith("```")
		|| /^#{1,6}\s+/.test(line)
		|| /^-{3,}\s*$/.test(line)
		|| line.startsWith("|")
		|| /^\s*[-*]\s+/.test(line)
		|| line.startsWith(">")
}

function render(md: string): string {
	const out: string[] = []
	const lines = md.split("\n")
	let i = 0
	while (i < lines.length) {
		const line = lines[i]!

		if (line.startsWith("```")) {
			const buf: string[] = []
			for (i++; i < lines.length && !lines[i]!.startsWith("```"); i++) buf.push(lines[i]!)
			i++
			out.push('<pre class="mono code"><code>' + esc(buf.join("\n")) + "</code></pre>")
			continue
		}
		const h = /^(#{1,6})\s+(.*)$/.exec(line)
		if (h) {
			// Demoted one level: the page shell already owns the h1.
			const level = Math.min(h[1]!.length + 1, 6)
			out.push("<h" + level + ">" + inline(h[2]!) + "</h" + level + ">")
			i++
			continue
		}
		if (/^-{3,}\s*$/.test(line)) {
			out.push('<hr class="rule">')
			i++
			continue
		}
		if (line.startsWith("|")) {
			const rows: string[][] = []
			for (; i < lines.length && lines[i]!.startsWith("|"); i++) {
				const cells = lines[i]!.slice(1).replace(/\|\s*$/, "").split("|").map((c) => c.trim())
				if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue
				rows.push(cells)
			}
			const head = rows.shift()
			out.push('<div class="tablewrap"><table class="mono">')
			if (head) out.push("<thead><tr>" + head.map((c) => "<th>" + inline(c) + "</th>").join("") + "</tr></thead>")
			out.push("<tbody>")
			for (const r of rows) out.push("<tr>" + r.map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>")
			out.push("</tbody></table></div>")
			continue
		}
		if (/^\s*[-*]\s+/.test(line)) {
			const items: string[] = []
			for (; i < lines.length && /^\s*[-*]\s+/.test(lines[i]!); i++) {
				items.push("<li>" + inline(lines[i]!.replace(/^\s*[-*]\s+/, "")) + "</li>")
			}
			out.push("<ul>" + items.join("") + "</ul>")
			continue
		}
		if (line.startsWith(">")) {
			const buf: string[] = []
			for (; i < lines.length && lines[i]!.startsWith(">"); i++) buf.push(lines[i]!.replace(/^>\s?/, ""))
			out.push("<blockquote>" + inline(buf.join(" ")) + "</blockquote>")
			continue
		}
		if (line.trim() === "") {
			i++
			continue
		}

		// Paragraph. The first line is consumed unconditionally, so the cursor always advances.
		const para: string[] = [line]
		i++
		for (; i < lines.length && lines[i]!.trim() !== "" && !opensBlock(lines[i]!); i++) para.push(lines[i]!)
		out.push("<p>" + inline(para.join(" ")) + "</p>")
	}
	return out.join("\n")
}

const NAV: readonly (readonly [string, string])[] = [
	["theorem.html", "Theorem"],
	["architecture.html", "Architecture"],
	["findings.html", "Findings"],
	["notebook.html", "Notebook"],
	["viewer/", "Run it"],
]

const MARK = '<svg viewBox="0 0 240 96" fill="none" aria-hidden="true">'
	+ '<g stroke="currentColor" stroke-width="1.25" opacity=".55"><circle cx="48" cy="48" r="29"/><circle cx="192" cy="48" r="29"/></g>'
	+ '<g fill="currentColor"><rect x="45" y="45" width="6" height="6"/><rect x="189" y="45" width="6" height="6"/></g>'
	+ '<g stroke="var(--phosphor)" stroke-width="1.25"><path d="M77 48 H113"/><path d="M127 48 H163"/><path d="M77 40 V56"/><path d="M163 40 V56"/></g>'
	+ '<text x="120" y="52" text-anchor="middle" fill="var(--phosphor)" font-family="ui-monospace, Menlo, monospace" font-size="13">3.0</text></svg>'

type Page = { file: string; src: string; title: string; eyebrow: string; h1: string; lede: string }

function shell(o: Page, body: string): string {
	const nav = NAV.map(([href, label]) =>
		'<li><a href="' + href + '"' + (href === o.file ? ' aria-current="page"' : "") + ">" + label + "</a></li>").join("")
	return [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		"<title>" + o.title + " — SEPARATION</title>",
		'<meta name="description" content="' + o.lede.replace(/"/g, "&quot;") + '">',
		'<link rel="icon" href="site/mark.svg" type="image/svg+xml">',
		'<link rel="stylesheet" href="site/app.css">',
		"</head>",
		'<body class="doc">',
		'<div class="hud" aria-hidden="true"><i></i><i></i><i></i><i></i></div>',
		'<header class="nav"><div class="wrap">',
		'<a href="./" aria-label="SEPARATION, home">' + MARK + "</a>",
		"<nav><ul>" + nav + "</ul></nav>",
		"</div></header>",
		'<main class="wrap prose">',
		'<p class="eyebrow">' + o.eyebrow + "</p>",
		"<h1>" + o.h1 + "</h1>",
		'<p class="lede">' + o.lede + "</p>",
		'<hr class="rule">',
		body,
		"</main>",
		'<footer><div class="wrap"><p class="dim mono">',
		'<a href="./">SEPARATION</a> · <a href="https://github.com/OoJae/separation">source</a>',
		" · generated from <code>" + o.src + "</code> by <code>npm run build:site</code>",
		"</p></div></footer>",
		"</body>",
		"</html>",
		"",
	].join("\n")
}

const pages: Page[] = [
	{
		file: "findings.html",
		src: "docs/API-NOTES.md",
		title: "Findings",
		eyebrow: "Runtime findings",
		h1: "21 findings against the shipped runtime",
		lede: "Read from the compiled bundle and its sourcemap, not the documentation. Four are filed upstream; a fifth turned out to be already fixed when we re-checked before filing.",
	},
	{
		file: "notebook.html",
		src: "docs/NOTEBOOK.md",
		title: "Notebook",
		eyebrow: "Engineering log",
		h1: "The long version, including what was wrong",
		lede: "A theorem that was briefly false, a fabricated headline output, a bug-finder that explored nothing, an airlock inert under a wall clock. How the front-page numbers were arrived at.",
	},
]

for (const p of pages) {
	const md = readFileSync(p.src, "utf8")
	// Drop the source file's own H1; the shell supplies the title.
	const body = render(md.split("\n").slice(1).join("\n"))
	const html = shell(p, body)
	writeFileSync(p.file, html)
	console.log("  " + p.file.padEnd(16) + " <- " + p.src.padEnd(22) + (html.length / 1024).toFixed(0) + " KB")
}
