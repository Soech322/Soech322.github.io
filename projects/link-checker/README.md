# Link Check

A Python command-line tool that crawls same-origin HTML pages and exports a report of working and broken links.

**Project type:** self-initiated demonstration, created with AI assistance. Not paid client work.

**Skills:** Python · Maintenance · Technical support

## Problem and approach

Small websites accumulate broken internal links. This standard-library crawler checks a bounded set of same-origin URLs, records HTTP failures and discovery sources, and exports JSON. External redirects are recorded but not followed.

## Run

Requires Python 3.10+. No installation or external packages.

~~~sh
python check_links.py https://example.com --max-pages 25 --output report.json
python -m unittest -v
~~~

Exit code 0 means no failures were found among checked URLs; 1 means at least one failure. The report is not proof that every URL on the website was checked.

## Demo

[Open the tool overview](https://Soech322.github.io/projects/link-checker/)

## Limitations

Defaults to 25 checked URLs; maximum 100. HTML bodies above 1 MB are not parsed. Checks anchor links only and does not execute JavaScript, check fragments, parse robots.txt, authenticate, or crawl external sites. Query variants are distinct URLs. Use only on sites you own or have permission to check.

## What to demonstrate to a client

Run the local tests, then check an authorized small website and inspect the JSON report.
