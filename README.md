# Lab Hub board data

This branch holds only `board.json`: the tasks, item requests and notes shown
on the Lab Hub dashboard. The lab Raspberry Pi and the GitHub Pages site
(https://richard-0421.github.io/lab-hub/) both read and write it through the
GitHub API, so every change made on the board shows up here as a commit.

The dashboard code lives on the `main` branch. Commits here never trigger a
Pages deploy and are never pulled by the Pi's code updater.

You normally never edit `board.json` by hand. If you do, keep it valid JSON;
the dashboards clean up missing fields and odd values automatically.
