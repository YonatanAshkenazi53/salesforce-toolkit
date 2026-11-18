// Admin Toolkit fixture: names SFTK_Kind__c.Tag__c only inside strings (dynamic access), so nothing compiles against it.
public with sharing class SFTK_Kind_Dyn {
    public static Object read(SObject r) { return r.get('Tag__c'); }
    public static String soql() { return 'SELECT Id, Tag__c FROM SFTK_Kind__c LIMIT 1'; }
}
