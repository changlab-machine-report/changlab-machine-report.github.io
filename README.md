# Chang Lab machine usage

Weekly GPU, CPU and storage use of the lab accounts on `changlab_merlin` and `changlab_assassin`,
published at https://changlab-machine-report.github.io/.

## How it works

`collector/changlab_report.py` runs as root on each machine:

- `changlab-report-sampler.service` records once a minute which tracked account holds each GPU and how
  busy that GPU is, plus each account's CPU time and RAM (from its systemd user slice). Raw samples stay
  on the machine in `/var/lib/changlab-report/samples/`.
- `changlab-report-publish.timer` runs every Monday around 00:30 (or at the next boot if the machine was
  off), summarizes the previous Monday-Sunday week, and pushes `data/<machine>/<week>.json` and
  `data/<machine>/index.json` here using that machine's deploy key.

`index.html` and `assets/` render the reports in the browser; there is no build step.

Only the accounts listed under `users` in `/etc/changlab-report/config.json` are recorded. Nothing about
other accounts is stored, not even GPU utilization while someone else holds a GPU.

## Install on a machine

    git clone https://github.com/changlab-machine-report/changlab-machine-report.github.io.git
    sudo bash changlab-machine-report.github.io/collector/install.sh changlab_merlin

Then add the public key it prints under the repo's Settings > Deploy keys, with **Allow write access**.

## Day-to-day

    sudo python3 /usr/local/lib/changlab-report/changlab_report.py report --week current   # this week so far, not published
    sudo systemctl start changlab-report-publish.service                                  # publish last week now
    journalctl -u changlab-report-publish.service                                        # result of the last publish
    sudoedit /etc/changlab-report/config.json                                            # change the tracked accounts

To track someone new, add them to `users` in the config on each machine and to `USERS` in
`assets/app.js` (that list fixes each account's color).

## Data

Each week file has, per account: `gpu_hours` (and `gpu_hours_by_gpu`), `avg_util`, `idle_gpu_hours`
(held at under 5% utilization), `peak_gpu_mem_gb`, `cpu_core_hours`, `avg_ram_gb`, `peak_ram_gb`, and
quota use for home and `/hdd1`; plus GPU-hours per day and the shared `/hdd1/data` total. `recorded_hours`
says how much of the week the sampler actually saw. When two accounts share a GPU, its time is split
between them.
