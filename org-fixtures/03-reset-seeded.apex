// RESET — remove all seeded records from an org (children first, then
// parents only where no non-seeded child still points at them). Safe to
// re-run; leaves hand-made records (names not matching the seed patterns).
delete [SELECT Id FROM Step_Order__c WHERE Name LIKE 'SO-%' OR Name LIKE ' SO-%' OR Name LIKE 'so-%'];
Set<Id> usedPd = new Set<Id>();
Set<Id> usedSn = new Set<Id>();
for (Step_Order__c sa : [SELECT Procedure_Definition__c FROM Step_Order__c]) usedPd.add(sa.Procedure_Definition__c);
for (Step_Order__c sb : [SELECT Step_Order_Name__c FROM Step_Order__c]) usedSn.add(sb.Step_Order_Name__c);
delete [SELECT Id FROM Procedure_Definition__c WHERE Name LIKE 'PD-%' AND Id NOT IN :usedPd];
delete [SELECT Id FROM Step_Order_Name__c WHERE Name LIKE 'SN-%' AND Id NOT IN :usedSn];
