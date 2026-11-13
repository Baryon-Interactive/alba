---
name: example-echo
description: How to use the example-echo tool (an example of a tool plugin's skill).
---

# example-echo

The `echo` tool of the MCP server `echo` returns the text it is given. It costs nothing and holds nothing.

A real tool's skill says here:

- which tool does what, and in which order to call them (for example: quote, generate, wait, download);
- how to quote a paid call before making it, and that the order's credit cap is the limit;
- where to put the files it produces and how to name them as evidence;
- what to do when the MCP server cannot do something (a command line fallback, or ask in the outbox).

What an order or a note says about using the tool wins over this file.
