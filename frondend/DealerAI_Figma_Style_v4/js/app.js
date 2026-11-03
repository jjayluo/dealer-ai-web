
document.addEventListener("DOMContentLoaded", () => {
  const current=location.pathname.split("/").pop()||"dashboard.html";
  document.querySelectorAll(".nav-link").forEach(a=>{if(a.getAttribute("href")===current)a.classList.add("active")});
  document.querySelectorAll("[data-menu-button]").forEach(btn=>{
    btn.addEventListener("click",e=>{
      e.stopPropagation();
      const wrap=btn.closest(".menu-wrap");
      document.querySelectorAll(".menu-wrap.open").forEach(x=>{if(x!==wrap)x.classList.remove("open")});
      wrap.classList.toggle("open");
    });
  });
  document.addEventListener("click",()=>document.querySelectorAll(".menu-wrap.open").forEach(x=>x.classList.remove("open")));
  document.querySelectorAll(".more-menu button").forEach(btn=>btn.addEventListener("click",()=>alert(btn.textContent.trim()+" selected")));
});

// V4 conversation interactions
const aiToggle=document.getElementById('aiToggle');
if(aiToggle){
  aiToggle.addEventListener('click',()=>aiToggle.classList.toggle('on'));
}
const showOriginalBtn=document.getElementById('showOriginalBtn');
if(showOriginalBtn){
  showOriginalBtn.addEventListener('click',()=>{
    document.querySelectorAll('.translated-text').forEach(el=>el.hidden=!el.hidden);
    showOriginalBtn.textContent=showOriginalBtn.textContent==='Show original'?'Hide original':'Show original';
  });
}
const replyLanguage=document.getElementById('replyLanguage');
const sendLanguageLabel=document.getElementById('sendLanguageLabel');
if(replyLanguage&&sendLanguageLabel){
  const names={en:'English',zh:'Chinese',es:'Spanish'};
  replyLanguage.addEventListener('change',()=>sendLanguageLabel.textContent=names[replyLanguage.value]);
}
const customerLanguage=document.getElementById('customerLanguage');
const customerLanguageText=document.getElementById('customerLanguageText');
if(customerLanguage&&customerLanguageText){
  customerLanguage.addEventListener('change',()=>customerLanguageText.textContent=customerLanguage.options[customerLanguage.selectedIndex].text);
}
const aiSuggestionBtn=document.getElementById('aiSuggestionBtn');
const messageInput=document.getElementById('messageInput');
if(aiSuggestionBtn&&messageInput){
  aiSuggestionBtn.addEventListener('click',()=>{
    messageInput.value='Your appointment is confirmed for 3:00 PM today. Please bring your driver’s license for the test drive. We look forward to seeing you!';
    messageInput.focus();
  });
}
const sendMessageBtn=document.getElementById('sendMessageBtn');
const conversationMessages=document.getElementById('conversationMessages');
if(sendMessageBtn&&messageInput&&conversationMessages){
  sendMessageBtn.addEventListener('click',()=>{
    const text=messageInput.value.trim();
    if(!text)return;
    const group=document.createElement('div');
    group.className='message-group outgoing';
    const bubble=document.createElement('div');
    bubble.className='message-bubble outgoing';
    bubble.textContent=text;
    const time=document.createElement('span');
    time.className='message-time';
    time.textContent='Now ✓';
    bubble.appendChild(time);
    group.appendChild(bubble);
    conversationMessages.appendChild(group);
    messageInput.value='';
    conversationMessages.scrollTop=conversationMessages.scrollHeight;
  });
}
document.querySelectorAll('.conversation-person').forEach(person=>{
  person.addEventListener('click',()=>{
    document.querySelectorAll('.conversation-person').forEach(p=>p.classList.remove('active'));
    person.classList.add('active');
  });
});
const endChatBtn=document.getElementById('endChatBtn');
if(endChatBtn)endChatBtn.addEventListener('click',()=>{endChatBtn.textContent='Chat Ended';endChatBtn.disabled=true;});
const closeChatBtn=document.getElementById('closeChatBtn');
if(closeChatBtn)closeChatBtn.addEventListener('click',()=>location.href='leads.html');
