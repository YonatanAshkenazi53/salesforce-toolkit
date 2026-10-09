// Admin Toolkit fixture for the Debugger video: a trigger that updates the record
// it fired on, so it fires again — the classic recursion. Its own guard stops it at
// 5; Salesforce would stop it at trigger depth 16 anyway. Exists to be SEEN in a
// debug log (the Debugger's analysis flags the repeated trigger and the flows it
// drags along); it does nothing useful.
trigger SFTK_Dbg_Loop on Account (after update) {
    List<Account> again = new List<Account>();
    for (Account a : Trigger.new) {
        if (a.SFTK_Dbg_Count__c != null && a.SFTK_Dbg_Count__c < 5) {
            again.add(new Account(Id = a.Id, SFTK_Dbg_Count__c = a.SFTK_Dbg_Count__c + 1));
        }
    }
    if (!again.isEmpty()) {
        System.debug('SFTK_Dbg_Loop: counting up on ' + again.size() + ' account(s) — this trigger will fire again');
        update again;
    }
}
