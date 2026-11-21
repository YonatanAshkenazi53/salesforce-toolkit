trigger SFTK_Hard_Trigger on dlrs__LookupChild__c (before update) {
    // Admin Toolkit HARD fixture: reads SFTK_Pkg_Tag__c on several lines and changes nothing.
    for (dlrs__LookupChild__c c : Trigger.new) {
        dlrs__LookupChild__c old = Trigger.oldMap.get(c.Id);
        Boolean changed = c.SFTK_Pkg_Tag__c != old.SFTK_Pkg_Tag__c;
        if (changed && c.SFTK_Pkg_Tag__c == 'sftk-never') System.debug(old.SFTK_Pkg_Tag__c);
    }
}
