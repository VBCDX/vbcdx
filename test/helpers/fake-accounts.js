// Users and groups as a real host keeps them (shadow-utils, USERGROUPS_ENAB=yes), for the fake
// hosts in the service tests: a stub weaker than the real commands would let an install "create"
// a user a real host refuses, or "delete" one that was never there.
//
// - useradd NAME: exit 9 when NAME exists; with --user-group, also exit 9 when the group NAME
//   exists ("group NAME exists - if you want to add this user to that group, use -g."). On
//   success it adds the user and, with --user-group, the group.
// - userdel NAME: exit 6 for an unknown user; otherwise removes the user and its private group.
// - groupdel NAME: exit 6 for an unknown group; otherwise removes it.
// - getent passwd|group NAME: found, or exit 2.
//
// `gid` is the number getent reports for a group (the test's own, so its sockets match); with
// gid null no group is ever found by getent, as on a host whose group lookup fails.

export function fakeAccounts({ users = [], groups = [], gid = process.getgid() } = {}) {
  const u = new Set(users);
  const g = new Set(groups);
  function answer(cmd, args) {
    const name = args[args.length - 1];
    if (cmd === "useradd") {
      if (u.has(name)) return { status: 9, stderr: `useradd: user '${name}' already exists\n` };
      if (args.includes("--user-group") && g.has(name)) {
        return { status: 9, stderr: `useradd: group ${name} exists - if you want to add this user to that group, use -g.\n` };
      }
      u.add(name);
      if (args.includes("--user-group")) g.add(name);
      return { status: 0 };
    }
    if (cmd === "userdel") {
      if (!u.has(name)) return { status: 6, stderr: `userdel: user '${name}' does not exist\n` };
      u.delete(name);
      g.delete(name);
      return { status: 0 };
    }
    if (cmd === "groupdel") {
      if (!g.has(name)) return { status: 6, stderr: `groupdel: group '${name}' does not exist\n` };
      g.delete(name);
      return { status: 0 };
    }
    if (cmd === "getent" && args[0] === "passwd") {
      return u.has(args[1]) ? { status: 0, stdout: `${args[1]}:x:999:991::/nonexistent:/usr/sbin/nologin\n` } : { status: 2 };
    }
    if (cmd === "getent" && args[0] === "group") {
      return gid !== null && g.has(args[1]) ? { status: 0, stdout: `${args[1]}:x:${gid}:\n` } : { status: 2 };
    }
    return null;
  }
  return { answer, users: u, groups: g };
}
