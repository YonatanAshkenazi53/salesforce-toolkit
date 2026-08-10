// SOURCE CLEAN — run in the SOURCE org (ashkenazy6): removes fixture
// garbage that leaked in (impostors, duplicate SO-0100), keeping the
// canonical 400 + hand-made records.
delete [SELECT Id FROM Step_Order__c WHERE Name LIKE 'SO-9%'];
List<Step_Order__c> dups = [SELECT Id FROM Step_Order__c WHERE Name = 'SO-0100' ORDER BY CreatedDate ASC];
List<Step_Order__c> extraDel = new List<Step_Order__c>();
for (Integer i = 1; i < dups.size(); i++) extraDel.add(dups[i]);
delete extraDel;
