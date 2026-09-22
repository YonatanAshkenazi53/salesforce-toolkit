// SFTK complex-deployment fixture — remove everything the seed scripts (and a
// deployment of them) created, in either org. Children go before parents where
// Salesforce would otherwise refuse. Files, leads, campaigns, products and
// price books are not children of Account, so they are deleted by name.
Database.DMLOptions dmo = new Database.DMLOptions(); dmo.optAllOrNone = false;
delete [SELECT Id FROM Task WHERE Subject LIKE 'SFTK CX%'];
delete [SELECT Id FROM Event WHERE Subject LIKE 'SFTK CX%'];
delete [SELECT Id FROM CampaignMember WHERE Campaign.Name LIKE 'SFTK CX%'];
delete [SELECT Id FROM Campaign WHERE Name LIKE 'SFTK CX%' AND ParentId != null];
delete [SELECT Id FROM Campaign WHERE Name LIKE 'SFTK CX%'];
delete [SELECT Id FROM Lead WHERE LastName LIKE 'SFTK CX%'];
delete [SELECT Id FROM OrderItem WHERE Order.Account.Name LIKE 'SFTK CX%'];
delete [SELECT Id FROM Order WHERE Account.Name LIKE 'SFTK CX%'];
delete [SELECT Id FROM Contract WHERE Account.Name LIKE 'SFTK CX%'];
delete [SELECT Id FROM Asset WHERE Name LIKE 'SFTK CX%' AND ParentId != null];
delete [SELECT Id FROM Asset WHERE Name LIKE 'SFTK CX%'];
delete [SELECT Id FROM CaseComment WHERE CommentBody LIKE 'SFTK CX%'];
delete [SELECT Id FROM Case WHERE Subject LIKE 'SFTK CX%' AND ParentId != null];
delete [SELECT Id FROM Case WHERE Subject LIKE 'SFTK CX%'];
delete [SELECT Id FROM OpportunityLineItem WHERE Opportunity.Name LIKE 'SFTK CX%'];
delete [SELECT Id FROM Opportunity WHERE Name LIKE 'SFTK CX%'];
delete [SELECT Id FROM PricebookEntry WHERE Product2.Name LIKE 'SFTK CX%'];
delete [SELECT Id FROM Pricebook2 WHERE Name LIKE 'SFTK CX%'];
delete [SELECT Id FROM Product2 WHERE Name LIKE 'SFTK CX%'];
delete [SELECT Id FROM ContentDocument WHERE Title LIKE 'SFTK CX%'];
delete [SELECT Id FROM Contact WHERE LastName LIKE 'SFTK CX%' AND IsPersonAccount = false AND ReportsToId != null];
delete [SELECT Id FROM Contact WHERE LastName LIKE 'SFTK CX%' AND IsPersonAccount = false];
delete [SELECT Id FROM Account WHERE (Name LIKE '%SFTK CX%') AND ParentId != null AND Parent.ParentId != null];
delete [SELECT Id FROM Account WHERE (Name LIKE '%SFTK CX%') AND ParentId != null];
delete [SELECT Id FROM Account WHERE Name LIKE '%SFTK CX%'];
if (Schema.getGlobalDescribe().containsKey('Individual')) {
  delete Database.query('SELECT Id FROM Individual WHERE LastName LIKE \'SFTK CX%\'');
}
System.debug('SFTK CX fixture removed');
