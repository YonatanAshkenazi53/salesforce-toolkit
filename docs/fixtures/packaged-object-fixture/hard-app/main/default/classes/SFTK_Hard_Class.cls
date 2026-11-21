public class SFTK_Hard_Class {
    // Admin Toolkit HARD fixture: SFTK_Pkg_Tag__c on several lines, in SOQL, a read, a write and a comparison.
    public static List<dlrs__LookupChild__c> tagged() {
        return [SELECT Id, Name, SFTK_Pkg_Tag__c FROM dlrs__LookupChild__c WHERE SFTK_Pkg_Tag__c != null ORDER BY SFTK_Pkg_Tag__c LIMIT 5];
    }
    public static String upper(dlrs__LookupChild__c c) {
        String t = c.SFTK_Pkg_Tag__c;
        return t == null ? null : t.toUpperCase();
    }
    public static void clear(dlrs__LookupChild__c c) {
        if (c.SFTK_Pkg_Tag__c == 'sftk-never') c.SFTK_Pkg_Tag__c = null;
    }
}
