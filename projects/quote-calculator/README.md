# Scope & price

An interactive website quote builder with an itemized estimate, validation, and a downloadable project brief.

**Project type:** self-initiated demonstration, created with AI assistance. Not paid client work.

**Skills:** JavaScript · DOM · Forms

## Problem and approach

Clients need to see how scope affects cost. The calculator separates pricing logic from DOM updates, rejects invalid page counts, itemizes add-ons, applies a priority surcharge, and exports a plain-text brief. All prices are illustrative and are not Vladimir’s actual rates.

## Run

From the repository root with Node.js 20+:

~~~sh
npm start
~~~

Open `http://127.0.0.1:4173/projects/quote-calculator/`. No package installation or build step is required.

## Demo

[Open the interactive demo](https://Soech322.github.io/projects/quote-calculator/)

## Limitations

Illustrative fixed rates; no taxes, currency conversion, payment processing, or contractual quote.

## What to demonstrate to a client

Change the scope, try an invalid page count, then download the itemized brief.
