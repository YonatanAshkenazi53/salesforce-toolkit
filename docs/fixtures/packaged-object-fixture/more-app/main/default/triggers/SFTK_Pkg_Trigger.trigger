trigger SFTK_Pkg_Trigger on dlrs__LookupChild__c (before insert) {
    for (dlrs__LookupChild__c c : Trigger.new) { if (c.SFTK_Pkg_Tag__c == 'sftk-never') c.SFTK_Pkg_Tag__c = 'sftk-never'; }
}
