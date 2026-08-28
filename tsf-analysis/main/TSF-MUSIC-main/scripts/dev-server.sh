#!/bin/bash
# Persistent dev server — keeps the Next.js dev server alive across bash sessions
cd /home/z/my-project
exec bun run dev > /home/z/my-project/dev.log 2>&1
