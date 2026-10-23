"""Your music's folders and the drives they live on (boards 14a–14t).

* ``markers``: a marker file at each managed folder's root, so a drive that's
  away reads as "isn't connected", never as an empty library; the watch that
  looks every 30 seconds; the guard the destructive jobs ask.
* ``disks``: the drives SYNCHRO.S can see (the drives folder the Docker step
  mounts), their free space and format, and folder sizes.
* ``paths``: validation of every path a person picks or types.
* ``yaml_blocks``: a small, comment-keeping YAML block editor (stdlib only),
  shared by the helper script and the slskd repoint.
* ``helper``: the Docker step's helper script and its one-use token.
* ``move``: the job that copies, checks and switches (and switches back).
* ``services``: slskd and the media servers, repointed at the switch.
"""
