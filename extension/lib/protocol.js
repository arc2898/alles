// How the top-bar pill and the ALLES app talk. This text is the contract; src/main/dbus-interface.js must say exactly the same
// (a test compares them). The app answers on the session bus as org.alles.App; the extension announces itself as org.alles.TopBar.
//
// SECURITY: the "Changed" and "Toggle" signals carry NO data. Anyone on the session bus can listen to a signal, so what is going on
// (the task, the text of a question) is only ever returned by GetState() to the caller. The bus is the user's own session bus: every
// program running as the user can call these methods, exactly as it could run commands directly; they cannot lower the guard on a
// risky action (the approval questions are still asked of a person).

export const APP_NAME = 'org.alles.App';
export const APP_PATH = '/org/alles/App';
export const APP_IFACE = 'org.alles.App1';
export const BAR_NAME = 'org.alles.TopBar';

export const INTERFACE_XML = `<node>
  <interface name="org.alles.App1">
    <method name="GetState"><arg type="s" direction="out" name="json"/></method>
    <method name="Submit"><arg type="s" direction="in" name="text"/></method>
    <method name="Stop"/>
    <method name="Listen"><arg type="b" direction="in" name="submit"/><arg type="s" direction="out" name="heard"/></method>
    <method name="StopListening"/>
    <method name="SetWake"><arg type="b" direction="in" name="enabled"/></method>
    <method name="AnswerApproval"><arg type="s" direction="in" name="id"/><arg type="b" direction="in" name="allow"/></method>
    <method name="OpenWorkspace"><arg type="s" direction="in" name="page"/></method>
    <method name="OpenSettings"/>
    <signal name="Changed"/>
    <signal name="Toggle"/>
  </interface>
</node>`;

export const PAGES = ['', 'chat', 'code', 'history', 'voice', 'topbar'];
