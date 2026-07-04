import sys
import asyncio
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "platform" / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.api.reports import _render_markdown
from app.services.agent_orchestrator import (
    AgentCapability,
    OrchestrationContext,
    OrchestrationError,
    route_with_platform_agent,
    set_orchestrator_chat_override,
)
from app.ws.router import _agent_assignment_notice, _message_with_decision_target, _merge_saved_message_content, _message_dedupe_key, _persist_vulnerability


class PlatformPhase2Tests(unittest.TestCase):
    def test_task_error_dedupe_key_is_stable_for_same_message(self):
        content = {"text": "濠电姷鏁告慨鐑藉极閸涘﹥鍙忛柣鎴ｆ閺嬩線鏌涘☉姗堟敾闁告瑥绻橀弻锝夊箣閿濆棭妫勯梺鍝勵儎缁舵岸寮诲☉妯锋婵鐗婇弫楣冩⒑閸涘﹦鎳冪紒缁橈耿瀵鏁愭径濠勵吅闂佹寧绻傚Λ顓炍涢崟顖涒拺闁告繂瀚烽崕搴ｇ磼閼搁潧鍝虹€殿喛顕ч埥澶娢熼柨瀣垫綌婵犳鍠楅〃鍛存偋婵犲洤鏋佸Δ锝呭暞閳锋垿鏌涘☉姗堝姛闁瑰啿鍟扮槐鎺旂磼濮楀牐鈧法鈧鍠栭…鐑藉极閹邦厼绶炲┑鐘插閸氬懘姊绘担鐟邦嚋缂佽鍊歌灋妞ゆ挾鍊ｅ☉銏犵妞ゆ牗绋堥幏娲⒑閸涘﹦绠撻悗姘卞厴瀹曟洘鎯旈敐鍥╋紲闂佸吋鎮傚褔宕搹鍏夊亾濞堝灝鏋︽い鏇嗗洤鐓″璺好￠悢鍏肩叆閻庯絽鐏氱紞灞解攽閻樻剚鍟忛柛鐘愁殜閵嗗啴宕ㄧ€涙ê浜辨繝鐢靛Т濞层倝寮告担鑲濇棃鏁愰崨顓熸闂佹娊鏀遍崹鍧楀蓟濞戞ǚ妲堟慨妤€鐗嗘慨娑㈡⒑閻熸澘鏆遍柛鐔稿濡叉劙骞掗弮鍌滐紲濠殿喗顨呴悧鎰板焵椤掑啯纭堕柍褜鍓氶鏍窗閺嶎厸鈧箓鎮滈挊澶嬬€梺褰掑亰閸樿偐娆㈤悙娴嬫斀闁绘ɑ褰冮鎾煕濮橆剚鍤囨慨濠勭帛閹峰懘鎮烽柇锕€娈濈紓鍌欐祰椤曆囧磹濮濆瞼浜辨俊鐐€栭幐楣冨磹閿濆應妲堥柕蹇曞Х椤︽澘顪冮妶鍡欏缂佸鐗撻獮蹇撁洪鍛嫼闂佸憡绋戦敃锔剧不閹剧粯鍊垫慨妯哄船閸樺鈧娲樺ú姗€骞嗛弮鍫熸櫜闁搞儮鏅槐鏌ユ⒒娴ｇ鎮戦柟顔煎€搁…鍥樄鐎规洦鍋婇幖褰掑礂婢跺﹣澹曞┑鐐茬墕閻忔繈寮稿☉娆嶄簻妞ゆ挾濮撮崢瀛橆殽閻愭彃鏆ｅ┑顔瑰亾闂侀潧鐗嗛幊鎰八囪閺岋綀绠涢幘鍓侇唹闂佺粯顨嗛〃鍫ュ焵椤掍胶鐓紒顔界懃椤繘鎼圭憴鍕彴闂佸搫琚崕鍗烆嚕閺夊簱鏀介柣鎰緲鐏忓啴鏌涢弴銊ュ箻鐟滄壆鍋撶换婵嬫偨闂堟刀銏犆圭涵椋庣М闁轰焦鍔栧鍕熺紒妯荤彟闂傚倷绀侀幉锟犲箰閸℃稑妞介柛鎰典簻缁ㄣ儵姊婚崒姘偓宄懊归崶顒夋晪闁哄稁鍘奸崹鍌炲箹濞ｎ剙濡肩紒鈧崘顔界叆婵犻潧妫欓ˉ婊堟煟閿曚椒鍚紒杈ㄦ崌瀹曟帒顫濋钘変壕濡炲瀛╅浠嬫煥閻斿搫孝闂傚偆鍨遍妵鍕即濡も偓娴滈箖鎮楃憴鍕缂傚秴锕悰顔芥償閵婏箑鐧勬繝銏ｆ硾閻牓宕ぐ鎺撯拻濞撴埃鍋撴繛浣冲懏宕查柟鐑樻尰閸欏繑銇勯幘璺衡偓锝夋晲婢跺﹪鍞堕梺闈涱檧婵″洭宕㈤鍫燁棅妞ゆ劑鍨烘径鍕箾閸欏澧柡鍡忔櫆娣囧﹪鎮欓鍕ㄥ亾閺嶎厼绠伴柟闂寸缁犺銇勯幇鍓佺暠闁绘挻锕㈤弻鐔告綇妤ｅ啯顎嶉梺绋匡功閸忔﹢寮诲☉妯锋瀻闊浄绲鹃埢鎾斥攽閳藉棗浜為柛瀣枔濡叉劙骞樼€涙ê顎撻梺鎯х箳閹虫挾绮敓鐘崇厽闁靛繆鏅涢悘娆撴煃瑜滈崜娆戝椤撱垹姹查柨鏃傛櫕缁♀偓闂傚倸鐗婃笟妤呭磿韫囨洜纾奸柣妯兼暩鐢盯鏌曢崶褍顏€殿噮鍣ｅ畷鍫曞幢濡儤璇炲Δ鐘靛仜缁绘劗鍙呭銈呯箰閹虫劙宕㈤崨濠勭瘈闁靛骏绲剧涵楣冩煠濞茶鐏＄紒鍌涘浮閺佸啴鍩€椤掑嫧鈧箓宕稿Δ浣镐画闂佺粯顨呴悧婊兾涢敃鍌涚參婵☆垵宕电粻鐐烘煛鐏炶濮傜€殿噮鍓欓埢搴ㄦ倷椤掑倻鈼ユ繝鐢靛仜閻°劎鍒掑鍥у灊闁规崘顕ч拑鐔兼煟閺冨洢鈧偓闁稿鎸搁埥澶娾枎濡厧濮虹紓鍌欒兌婵敻鎮уΔ鍛﹂柛鏇ㄥ灠鍞梺鎸庣箓閹虫劖绂掓總鍛娾拺閻庡湱濯鎰版煕閵娿儲鍋ョ€殿噮鍋勯鍏煎緞婵犲嫷妲规俊鐐€栫敮濠囨倿閿曞倹鍎婇柟鍓х帛閻撶喖骞栧ǎ顒€鈧倕顭囬幇顓犵闁告瑥顦遍惌鎺斺偓瑙勬磻閸楀啿顕ｆ禒瀣垫晣婵犙勫劤娴滄儳霉閿濆洨銆婃俊鎻掔墛閹便劌螖閳ь剙螞濞嗘挸纾介柛顭戝亗缁诲棝鏌熺紒妯虹瑲婵犫偓娴煎瓨鐓熸俊銈勭劍缁€瀣偓娈垮枟閻擄繝銆侀弮鍫濋唶闁绘柨寮剁€氳棄鈹戦悙鑸靛涧缂傚秮鍋撳┑鈽嗗亜鐎氭澘鐣烽妷鈺傚仭闁逛絻娅曢弬鈧俊鐐€栧Λ浣肝涢崟顖氱闁靛牆顦伴悡鍐偣閸ヮ亜鐨洪弫鍫ユ⒑鏉炴壆鍔嶉柛鏃€鐗曢銉╁礋椤掑倻鐦堥梺鍛婃礀婢у酣宕ヨぐ鎺撯拻闁稿本鐟х粣鏃€绻涙担鍐叉处閸嬪鏌涢埄鍐巢闁搞儯鍔岄閬嶆煛婢跺鐏╅柨娑欑懇濮婂宕掑鍗烆杸闂佺绻戝畝绋款嚕椤曗偓瀹曞ジ鎮㈤崨濠勫礁闂傚倷绀侀幉鈩冪瑹濡ゅ懎鍌ㄩ柦妯侯槴閺嬫棃鏌＄仦璇插姕闁抽攱鍨块弻鐔煎箚閺夊晝鎾绘煛娓氣偓娴滃爼寮诲☉銏犖╅柕澶涚畱娴犳挳鎮楀▓鍨灕妞ゆ泦鍥х叀濠㈣泛谩閻斿吋鐓ラ悗锝呯仛缂嶅苯鈹戦悩鎰佸晱闁哥姵顨婇妴鍐川鐎涙ê浜遍梺绯曞墲钃遍柛娆忕箲缁绘盯骞嬪▎蹇曚痪闂佹娊鏀遍崹鍧楀蓟閿濆鍋勯柛娑橈功閸戯繝姊洪崫鍕棦濞存粌鐖煎璇测槈閵忊€充簻缂備礁顑嗛娆徫涢崱妞绘斀闁炽儱鍟跨痪褔鏌涢弮鈧悷鈺呮偘椤曗偓楠炴帒螖閳ь剛鐚惧澶嬬厱閻忕偛澧介悳鑽ょ磼閸楃偛绾х紒缁樼箘閸犲﹤螣濞茬粯缍夐梻浣规偠閸斿宕￠幎鐣屽祦闁哄稁鍙庨弫鍐煥閺冨洤浜圭紒瀣箻濮婅櫣娑甸崨顔兼锭闂傚倸瀚€氫即宕哄☉銏犵闁挎棁妫勬禒顖炴⒑閹肩偛鍔村ù婊勭矒閹啴鎼归崷顓狅紲闂佺粯锚瀹曨剙鐣甸崱娑欑厸閻忕偛澧藉ú鎾煙椤斿搫鐏茬€规洏鍔嶇换婵嬪礋椤撴稒鐎兼繝纰夌磿閸嬫垿宕愰妶澶婄；闁告洦鍘藉畷鏌ユ煙闁箑鏋涚€殿喖寮舵穱濠囨倷椤忓嫧鍋撻弴鐘冲床闁归偊鍠掗崑鎾愁潩閻撳孩鐝濆銈冨灪閻熲晛鐣烽崼鏇ㄦ晢濞达絽鎼獮宥夋⒒娴ｅ搫甯舵繝鈧潏銊︽珷婵°倕瀚ㄦ禍鍦喐韫囨洘顫曢柟鐑橆殔缁犵敻鏌熼悜妯诲碍濞寸姵鎸冲铏规嫚閳ヨ櫕鐝濈紓浣哄У閻楃娀鐛崘鈺冾浄閻庯綆浜滅粣娑欑節閻㈤潧浠ч柛瀣尵閳ь剚鑹鹃妶绋款潖缂佹ɑ濯撮柦妯侯槸閹偤姊洪崫銉バｉ柛鏃€娲熼垾锕傚垂椤曞懏寤洪梺閫炲苯澧い鏇秮楠炲酣鎳為妷褍濮搁柣搴＄畭閸庡崬螞瀹€鍕婵炲樊浜濋悡鐔兼煏韫囧﹥娅呴柣蹇涗憾閺屾盯鎮╅崘鎻掓懙閻庤娲樺畝鎼佸箖瑜斿畷鐓庘槈濡ゅ啰娉块梻鍌欑閹碱偄霉閸屾稓顩查柣鎰暩閻挻銇勯弮鍌滄憘婵炲牅绮欓弻锝夊箛椤掑娈舵繝鈷€灞藉⒋闁哄瞼鍠庨悾锟犳偋閸繃鐣婚梻浣侯攰濞呮洟鎮ч弴鈶┾偓锕傚锤濡ゅ﹥鏅ｉ梺缁樺姇瀵爼鎮橀幘缁樷拺缂備焦蓱閻撱儲淇婇锝囩疄妤犵偛鍟伴幉鎾礋椤掆偓椤繝姊洪悷鏉挎Щ闁活厼鐗撳畷婵嬪川鐎涙ǚ鎷虹紓浣割儏閻忔繈顢楅姀銈嗙厱闁靛鍎查崑銉р偓娈垮枦椤曆囧煡婢跺á鐔奉煥閸涱厽鐏堥梺璇″枟缁矁鐏掗梺缁樺灦钃遍柣锝堝亹缁辨捇宕掑顑藉亾閻戣姤鍤勯柛鎾茬閸ㄦ繃銇勯弽銊х煂闁活厽鐟╅弻鐔兼倻濡櫣鍔搁梺缁樺笂缁瑩鎮￠锕€鐐婇柕濞р偓濡插牏绱撴担鎻掍壕闂佸壊鍋侀崹娲窗閹邦喒鍋撻獮鍨姎妞わ富鍨跺浼村Ψ閳哄倸鈧爼鏌ｉ幇顓炵祷闁抽攱姊荤槐鎺楀煢閳ь剟宕戦幘缁樷拻濞撴埃鍋撴繛浣冲懏宕查柛顐犲劚閸ㄥ倹绻涘顔荤盎闁告艾缍婇弻宥堫檨闁告挾鍠庨～蹇撁洪鍕唶闁瑰吋鐣崹褰捤囬埡鍌滅閻庢稒顭囬惌瀣磼椤旇姤宕屾鐐插暞閵堬綁宕橀埡浣插亾婵犳碍鐓㈡俊顖欒濡插摜鈧鎸稿Λ婵嗩潖濞差亝顥堟繛鎴炴皑椤斿﹥绻濆▓鍨灓闁稿繑锕㈤妴浣肝熸總鑺ユそ椤㈡棃宕ㄩ鍛伖闂傚倷绀佸﹢閬嶁€﹂崼鈶╁亾濞戞帗娅婇柛鈺傜洴楠炴帒螖娴ｅ搫骞愰梻浣告啞缁牏绮堟担鍦洸闁规鍠掗崑鎾舵喆閸曨剛锛橀梺鎼炲妺缁瑩鐛崘鈺冾浄閻庯綆浜滅粣娑欑節閻㈤潧浠ч柛瀣尵閳ь剚鑹鹃妶绋款潖缂佹鐟归柍褜鍓欓…鍥嚒閵堝倸浜鹃梻鍫熺〒閻掑摜鈧娲忛崹钘夌暦濠婂棭妲奸梺鍝勬缁秶鎹㈠☉銏犵婵炲棗绻掓禒楣冩⒑缁嬫鍎嶉柛鏂跨Ч婵＄敻宕熼姘敤闂侀潧顭堥崐妤冩崲娴ｇ硶鏀介柣鎰皺婢ф稓绱掗濂稿弰闁糕斁鍋撳銈嗗笒閸犳艾顭囬幇顓犵閻犲泧鍛殼閻庤娲栫紞濠傜暦婵傜鍗抽柣鎰暩閺嗩偅绻濋悽闈涗粶婵☆偅鐟╅獮鎰節濮橆剛锛欑紓鍌欑劍鐪夌紒璇叉閵囧嫰寮介妸褏鐓€闁汇埄鍨甸崺鏍€冮妷鈺傚€烽柤纰卞劮閿濆惓搴ㄥ炊瑜濋煬顒勬煙椤旂晫鎳囨い銏℃瀹曠喖濡搁妷銈咁棜闂備礁鎼粙渚€宕㈡禒瀣；閻庯綆鍋傜换鍡涙煏閸繃鍣归柡鍡欏枛閺岋綁顢橀悢鐑樺櫚闂佸搫鐬奸崰鏍箖濠婂喚娼ㄩ柛鈩冿供閳ь剙顦扮换婵嬪閿濆懐鍘梺鍛婃⒐濞茬喖寮荤€ｎ喖鐐婇柕濞у懐妲囬梻鍌氬€搁悧濠勭矙閹达箑姹查柣鎰劋閻撴盯鏌涚仦缁㈡當濞存粓绠栧濠氬磼濮橆兘鍋撻悜鑺ュ€块柨鏇炲€搁崙鐘测攽閸屾粠鐒鹃柣銈囧亾缁绘盯骞嬪▎蹇曚患闂佹眹鍊ら崰妤呭Φ閸曨垰鍐€妞ゆ劦婢€缁墎绱掗悙顒€鍔ょ紓宥咃躬瀵鎮㈤崗鑲╁姺闂佹寧娲嶉崑鎾绘煕濡粯灏﹂柡宀嬬節閸┾偓妞ゆ帊鑳堕々鐑芥倵閿濆骸浜為柛娆忔閳规垿鎮欓弶鎴犱桓闂佹寧纰嶉妵鍕疀閿濆嫰鍋楅梺鍝勭焿缂嶄線鐛幒妤€绠婚柟棰佺濞堟繈姊绘笟鈧褍煤閵堝洠鍋撳顐㈠祮鐎殿噮鍋婂畷鎺楁倷閺夋垶鐤呴梻渚€娼чˇ顓㈠磿闁秴缁╂い鎾卞灪閳锋帒霉閿濆懏鍟為柟顖氱墕椤法鎹勯悜妯烘灎閻庤娲樼划宀勫煘閹达箑骞㈤柍杞扮劍椤斿倿姊绘担鍛婂暈婵炶绠撳畷婊冣枎閹寸儐鍋ㄩ梺缁樺姉椤ｄ粙宕戦幘璇茬濠㈣泛锕ｆ竟鏇㈡⒒娓氣偓閳ь剛鍋涢懟顖涙櫠閹绢喗鐓欐い鏇炴缁♀偓濡ょ姷鍋為敃銏狀嚕椤掑嫬唯闁挎棁濮ゅ鎴濃攽閿涘嫬浜奸柛濠冪墪椤繑绻濆顑┿儵鎮楅敐搴℃灈缂佲偓婢舵劖鐓熼柡鍐ㄦ处椤忕姷鐥幆褍鎮戦柕鍥у瀵挳鎮欓弶鎴烆仩闂備浇顕ф蹇曞緤鐠恒劍顫曢柟鐑橆殢閺佸鏌涘☉鍗炲箹缂侇偄绉瑰铏规嫚閳ヨ櫕鐏侀梺鎼炲妺缁瑩鐛崘顔肩労闁告劏鏅涢崝鍛存⒑閹稿海绠撻柟鍐叉唉椤ゅ倸鈹戦悩娈挎殰缂佽鲸娲熷畷鎴﹀箣閿曗偓绾惧綊鏌″畵顔艰嫰閺呯姵绻濋悽闈浶ｉ柤鐟板⒔婢规洘绻濆顓犲幍闂佺粯鍔﹂崜娑㈠汲濡ソ鐟邦煥閸曨厾鐓侀梺闈涙搐鐎氫即鐛Ο鍏煎磯閺夌偟澧楅崟鍐磽閸屾瑧顦﹂柡鍫墰閳ь剛鐟抽崶顬箓鏌涢弴銊ョ仭闁哄懏绻傞湁闁挎繂鎳忕拹锟犳煏閸℃ê濮囨い顏勫暣婵¤埖鎯旈垾宕囧摋闂備胶顭堟鎼佲€﹂悿顖涱棨闁诲氦顫夊ú鏍洪妸褍顥氬┑鍌氭啞閸嬶綁鏌涢妷顔荤盎闁汇劌鎼…鑳槼婵炲弶锕㈡俊鐢稿礋椤栵絾鏅濋梺闈涚箞閸ㄥ顢欓崶顒佺厽闁规儳宕埀顒佺墵婵＄敻宕熼鍓ф澑闂佸湱鍋撻崜姘閸︻厾纾藉ù锝囶焾閼稿綊鏌ｉ弽顐㈠付妞ゎ偄绻愮叅妞ゅ繐瀚粣娑欑節閻㈤潧孝闁哥噥鍋婅棟闁冲搫鎳忛埛鎴︽煕濞戞﹫鏀婚悘蹇庡嵆閺岋綁鎮㈤弶鎴濆Е闂佺硶鏂傞崹褰掝敇閸忕厧绶炲┑鐐╂媰閸ャ劎鍘遍梺闈涱槶閸ㄥ搫鈻嶉崶顒佺叆婵炴垶鐟х粻鏍磼缂佹娲存鐐搭焽婢规洜鈧綆浜跺Λ鐔哥節閻㈤潧浠滈柣顏冨嵆瀹曟劕鈹戦崱鈺佹闂佸綊妫块悞锕傚磻閸曨垱鐓曢煫鍥ㄨ壘娴滃綊鏌涘Ο鍏兼毈婵﹥妞藉畷銊︾節閸曘劍顫嶉梻浣瑰濞插繘宕曢棃娑氭殾闁圭増婢樼粻娑㈡煟濡も偓閻楀繘宕㈤棃娑辨富闁靛牆妫欑壕鐢告煕鐎ｎ偅灏电紒杈ㄥ浮閹晛鐣烽崶褉鎷版俊銈囧Х閸嬫盯宕锔光偓锕傚Ω閳轰線鍞堕梺缁樻椤ユ挸顬婇灏栨斀闁绘﹩鍠栭悘杈ㄧ箾婢跺娲撮柟顖氱焸瀹曞ジ濡烽妷銊愭洟姊洪崨濠勨槈闁宦板姂閸╂盯骞掗幊銊ョ秺閺佹劙宕堕妸銉︾暚婵＄偑鍊栧ú妯煎垝瀹ュ洦宕叉繛鎴欏灩缁犵敻鏌熼悜妯荤仜鐟滃繘鍩€椤掑喚娼愭繛鍙夛耿瀹曞綊宕稿Δ鍐ㄧウ濠殿喗銇涢崑鎾垛偓瑙勬礃缁秹骞忛崨瀛樺仏閻庣數顭堢花銉╂⒒閸屾艾鈧娆㈠璺虹劦妞ゆ帒鍊告禒婊堟煠濞茶鐏￠柡鍛板煐鐎佃偐鈧稒顭囬崢鎾绘偡濠婂嫮鐭掔€规洘绮撴俊姝岊槾缂佲偓婵犲洦鐓曢柍鈺佸暟閳藉鐥幑鎰靛殭闂囧鏌ㄥ┑鍡樺櫤閻犳劏鍓濋妵鍕煛娴ｅ摜楠囩紓浣虹帛缁诲啰鎹㈠┑瀣＜婵犲﹤鍠氶弶鎼佹⒒娴ｈ櫣甯涢柟绋款煼閹兘鍩￠崨顓℃憰闂佺粯姊婚崕銈夊窗閸℃稒鐓曢柡鍥ュ妼娴滄粍銇勯銏⑿ょ紒杈ㄥ笧缁辨帡濮€閻樿尙鐫勭紓鍌欒兌婵敻鎮ч弴銏″仼闁绘垹鐡旈弫宥夋煟閹邦垰鐨烘い鏃€鍔栫换娑欐綇閸撗冨煂闂佸憡蓱缁捇鐛箛鎾佹椽顢旈崨顏呭闂備線娼荤€靛矂宕ｆ惔銊﹀€块柣鎰靛墰缁犻箖鎮楅悽娈跨劸闁告ɑ鎸抽弻娑㈠煛娓氬﹨鍚悗娈垮枟閹告娊骞冮埡鍛仺缁炬澘顦辨惔濠傗攽閿涘嫬浜奸柛濠冪墪铻炲ù锝堫潐閸欏繘鏌曢崼婵囧櫧闁哄棴濡囬埀顒€鍘滈崑鎾绘煃瑜滈崜鐔煎春閳ь剚銇勯幒宥囪窗闁哥喎绻橀弻娑㈡偐瀹曞洤鈷岄梺鐐藉劵缁犳捇骞冨鍫熷癄濠㈣泛顑囬埀顒夊墴濮婃椽宕烽鐑嗘毉濠电姰鍨洪敃銏ゆ偘椤曗偓婵偓闁炽儴灏欑粻姘渻閵堝棛澧痪鏉跨Ч楠炲棝宕煎┑鍐╂杸闂傚嫬娲ら埢宥夊即閻旇　鏀虫繝鐢靛Т濞诧箓宕愰柨瀣ㄤ簻闊洦鎸搁銈夋煕鐎ｎ偅宕岀€殿喕绮欓、姗€鎮㈤摎鍌滅秿濠电姴鐥夐弶搴撳亾閺囥垹鐤い鎰剁畱閸ㄥ倹绻濋棃娑卞剰缂佺姾顫夌换娑㈡晲鎼粹€愁潻闂佽娴氶崰鏍€﹂懗顖ｆ缂備胶绮换鍌烇綖韫囨梻绡€婵﹩鍓涢敍婊冣攽椤旀枻渚涢柛蹇旓耿瀹曟垿骞橀幖顓熜ч柟鑹版彧缁插潡鎮為崗鑲╃闁圭偓娼欓悞褰掓煕鐎ｎ偅灏版い銊ｅ劦閹瑥顔忛瑙ｆ瀰闂備浇妗ㄩ悞锕傚箲閸ヮ剙绠栭柍鍝勬媼閺佸啴鏌ｉ弮鍥ㄨ吂濠㈣娲熷娲箰鎼淬垻顦ラ梺绋匡攻閹倿骞冨▎鎰瘈闁告劧缂氱花濠氭⒑閻熺増鎯堟俊顐ｎ殕缁傚秵銈ｉ崘鈹炬嫼濠殿喚鎳撳ú銈夊焵椤掍緡娈滅€规洘鍨块獮妯兼嫚閸欏偊绠撻弻娑㈠即閵娿儳浠╃紓浣哄У閻╊垶寮婚弴鐔虹瘈闊洦娲滈弳鐘测攽閻愬弶鍣洪柤褰掔畺閸╃偤骞嬮敃鈧悞娲煕閹扳晛濡跨紒浣哄厴濮婅櫣绱掑鍡樼暦闂佸湱鎳撳ú銈夘敋閿濆棛绡€婵﹩鍘藉▍婊勭節閵忥絾纭炬い顓у墮椤洦绻濋崶銊㈡嫼闂傚倸鐗婄粙鎾剁不濮樿埖鐓涢柛娑卞枤缁犵偟鈧娲樼换鍫濈暦椤愶箑唯鐟滃繘鏁嶅┑鍥╃閺夊牆澧界粙鑽ゆ喐閺夊灝鏆炵紒鍌氱У閵堬綁宕橀埞鐐闂備礁鎲￠幐鏄忋亹閸愨晝顩叉繝闈涚墢绾惧ジ鏌涢幘鑼妽闁绘帒娼￠弻鏇㈠炊閵娿儱顫掑Δ鐘靛仦鐢繝鐛Ο灏栧亾濞戞瑯鐒界憸鐗堟倐濮婂宕掑▎鎴М婵犮垻鎳撻敃顏勭暦閹达箑骞㈡繛鎴烇耿濡兘姊洪棃娑辨濠碘€虫喘閵嗗懘鎮滈懞銉у帗闂佸憡绻傜€氼參宕冲ú顏呯厓闂佸灝顑呴悘鎾煛瀹€鈧崰鎾跺垝濞嗘挸绠伴幖娣灩闂傤垶姊绘担鐟板闁搞劌宕叅婵犲﹤鎳忛～鏇㈡煙閻戞﹩娈㈤柡浣革躬閺屻倝骞侀幒鎴濆缂佺偓婢樼粔鎾€旈崘顔嘉ч幖绮光偓鑼泿缂傚倷鑳剁划顖炲垂閹稿簼绻嗛柛顐ｆ礃閺呮粓鏌ｉ幇闈涘闁哄懏濞婂娲濞戞艾顣洪柣搴㈠嚬閸欏啴骞嗛崼锝囩杸婵炴垶鐟㈤幏缁樼箾鏉堝墽鍒伴柟璇х磿閹峰綊鏁撻悩宕囧幈闁圭厧鐡ㄧ粙鎴﹀焵椤掍胶绠撻柣锝囨焿閵囨劙骞掗幋鐙€鍞撮梻浣藉Г閿氭い锕備憾閹即濡烽敂鍓х槇闂佹眹鍨藉褍鐡繝鐢靛仩椤曟粎绮婚幘璇叉槬婵炴垯鍨圭粻锝夋煥閺冨倹娅曢柛妯哄船閳规垿鎮╃紒妯婚敪闁诲孩鍑归崜鐔风暦濠靛棭娼╅悹鍝勬惈閸炪劑姊虹捄銊ユ灁濠殿喚鏁婚崺娑㈠箣閻樼數锛濇繛杈剧悼濞呫垺绗熷☉娆戠闁割偆鍠愮粈鍐煏閸パ冾伃濠碘剝鎮傛俊鐤槻闁愁亪浜跺娲川婵犲倻鐟查柣銏╁灣閸嬨倝宕洪埀顒併亜閹烘埊鍔熺紒澶屾暬閺屾盯鎮╁畷鍥р拡缂備緡鍠栭…鐑藉箹瑜版帩鏁冮柨娑樺閻ｉ箖姊绘笟鈧褔鎮ч崱娆屽亾濮樼厧鐏︾€规洘顨呴悾婵嬪礋椤掑倸骞堥梻浣告惈閸婅棄鈻旈弴銏犳槬闁挎繂顦伴悡娆愩亜閺冨倻鎽傛繛鍫熺矒閺岋絽鈽夐崡鐐寸彎閻庤娲栫紞濠囥€佸▎鎾村亗閹兼惌鍠楃紞鎾寸節閻㈤潧啸妞わ綀妫勫嵄闁告稒娼欑壕濠氭煕濞戞鎽犻柛搴″閵囧嫰寮介妸锔炬闂佸搫妫寸粻鎾诲蓟閺囷紕鐤€閻庯綆浜栭崑鎾诲即閻樺吀绗夐梺鑽ゅ枑閸ｇ銇愰幒鎾存珳闂佸憡渚楅崰娑氭兜閳ь剟姊绘担鍛婂暈閻绱掗鐣屾噧閾荤偤鏌涘☉娆愬剹闁轰礁鍟撮弻鏇＄疀婵炴儳浜鹃柟棰佺劍琚╂繝鐢靛Х閺佹悂宕戝☉姗嗗殨闁割偅娲橀崑瀣繆閵堝懎鏆熼柣顓烆樀閺岀喖鎮滃Ο璇差槱濠碘剝褰冮妶绋款潖濞差亝顥堟繛鎴炵懄閹瑩鏌ｆ惔銏㈢叝闁告濞婃俊瀛樻媴閸撳弶寤洪梺閫炲苯澧存鐐插暙閳诲酣骞橀幖顓燁棃婵犵數鍋為崹鍏笺仈缁嬫鐔嗛柟杈鹃檮閳锋帡鏌涚仦鍓ф噮妞わ讣绠撻弻鐔哄枈閸楃偘鍠婂Δ鐘靛仜閿曘儵骞嗛弮鍫澪╅柨鏇楀亾濞存粠鍨辩换婵嬫濞戞ǚ鍋撴繝姘ｂ偓锕傚醇閵忣澀绗夐梺缁橆焽缁垶鎮￠悢闀愮箚妞ゆ牗绮庣敮娑㈡煏閸モ晛鏋涢柡灞稿墲閹峰懐绮欏▎鍙ョ磾闂備礁鎼惌澶岀不閹达絿浜藉┑鐐存尰閸戝綊宕归崡鐐存瘎濠电姷鏁告慨浼村垂婵傞潻缍栧璺衡姇濞差亝鍋勫┑鍌氼槹缂嶅骸鈹戦悙鍙夆枙濞存粍绮庣划鍫ュ醇閵夛妇鍘剧紒鐐緲瀹曨剚鏅堕鈧幃浠嬵敍濡搫濮﹀┑顔硷龚濞咃絿鍒掑▎蹇婃瀻闁诡垎鍐棈闂傚倷鑳堕、濠傗枍閺囥垹绀夐柡鍥ュ灩閻撴繈骞栧ǎ顒€濡兼い顐㈡嚇閺屾洟宕煎┑鍥ф畬闂佺濮ゅú鐔奉潖濞差亝顥堟繛鎴ｉ哺椤庡棛绱撴担鍝勑ｉ柛銊ユ健瀹曟椽鍩€椤掍降浜滈柟鍝勬娴滈箖姊虹拠鑼鐎光偓閹间胶宓侀柛顐犲劚鎯熼梺闈涱槸濞寸兘宕伴弽顓炵畺闁斥晛鍟崕鐔兼煃閵夈劌鐨洪悽顖涚☉閳规垶骞婇柛濠冾殕閹便劑鎮滈挊澶岋紱闂佺粯鍔楅崕銈夊疾濠靛鐓忛煫鍥ь儏閳ь剚娲熼幏鎴︽偄閸忚偐鍘介梺鍝勫暙濞层倖绂嶉崷顓涘亾鐟欏嫭灏紒鑸靛哺瀵鈽夐埗鈹惧亾閿曞倸绠ｆ繝闈涙川娴滄儳鈹戦悙宸殶濠殿喗鎸虫俊鍓佺矙濞嗙偓缍庨梺鎯х箰閸樻粓宕戦幘璇叉嵍妞ゆ挾鍎愰埀顒€鏈换娑㈠礂閻撳骸顫掗梺鍝勬湰閻╊垱淇婇幖浣肝ㄧ憸蹇旑殭闂傚倷鑳剁涵鍫曞棘娓氣偓瀹曟垿骞橀幇浣瑰瘜闂侀潧鐗嗗Λ妤冪箔閹烘鐓ラ柡鍥朵簻椤╊剛绱掗鑺ヮ棃婵☆偄鍟湁闁靛繈鍨洪崵鈧銈庡幑閸旀垵鐣烽妸鈺婃晣婵犻潧娴傚鐔兼⒒娴ｈ棄袚閽冭京绱掔拠鑼ⅵ鐎殿喖顭烽崺鍕礃閵娧呯嵁闂佽鍑界紞浣割焽瑜斿畷婵堜沪鐟欙絾鏂€闂佺粯鍔曢悺銊т焊椤撶喆浜滄い鎾跺Т閸樺鈧鍠栭…宄邦嚕閹绢喖顫呴柣妯款嚙閺佽绻濋悽闈涒枅婵炰匠鍏犲綊宕掑В鍏肩洴閹瑧鈧潧鎽滈惁鍫濃攽閻愯尙澧曢柣蹇旂箞瀵鈽夊▎宥勭盎闂佹寧姊婚崑鎾诲汲椤掑倵鍋撳▓鍨灕妞ゆ泦鍥х叀濠㈣埖鍔曢～鍛存煃閵夈儱甯犳慨瑙勵殜濮婄粯鎷呴崨濠傛殘闂佸憡姊归悧鐐哄Φ閹版澘绀冩い鏇炴缁嬪繘鏌熼崗鑲╂殬闁告柨绉归崺娑㈠箣閿旇В鎷哄銈嗗姂閸婃洘绂掑鍫熺厾婵炶尪顕ч悘锟犳煛閸涱厾鍩ｆい銏＄☉椤劑宕ㄩ鍡欑闂傚倷绀侀幖顐λ囬崘娴嬫灃闁哄洨鍠愬▍蹇涙⒒閸屾瑦绁版い鏇熺墵瀹曞綊骞嶉鐟颁壕婵﹩鍋勫畵鍡涙煏閸℃洜顦﹂柍钘夘槸椤粓宕卞Ο鍝勫帪闂傚倷鑳堕…鍫㈡崲濡ゅ懎纾婚柟閭﹀枤閻瑥霉閿濆洨銆婇柡鈧禒瀣厽婵☆垵娅ｆ禒娑㈡煛閸″繑娅呴柍瑙勫灴椤㈡瑩鎮欓浣圭槗闂備胶顢婂▍鏇犳崲閸繄鏆︽繝濠傛－濡茶顪冮妶鍐ㄥ姕鐎光偓閹间礁钃熸繛鎴炵矌閻も偓濠殿喗锕╅崗娑樞уΔ鍐＝濞达絽鎼埢鍫㈢磼閻樺磭澧电€殿喛顕ч埥澶愬閻橀潧濮堕梻浣侯焾缁绘帗鍒婇鐔侯洸闁绘劙娼ч崹婵囥亜閹惧崬鐏╃紒鐘烘珪娣囧﹪濡堕崟顔煎帯闂佸憡锚瀹曨剟鍩為幋锕€鐓￠柛鈩冾殘娴犫晠姊哄Ч鍥у缂佽鐗嗛悾鐑藉箣閿曗偓缁犲鎮归崶顏勭毢闁汇倐鍋撴繝鐢靛仩閹活亞寰婇崸妤€绠犻柟鍓х帛閸庡﹥绻濇繝鍌滃闁抽攱甯掗妴鎺戭潩閿濆懍澹曟繝鐢靛仒閸栫娀宕堕妸銉ょ綍闂備胶纭堕崜婵嬫晝閳轰讲鏋斿ù鐘差儐閻撴瑩姊婚崒婊庢闁稿繐鐬奸埀顒冾潐閹搁娆㈠璺鸿摕闁炽儲鍓氶崥瀣箹缁厜鍋撳畷鍥跺晥闂傚倷鑳剁划顖炲箰妤ｅ啫绐楅柟閭﹀幘閳瑰秴鈹戦悩鍙夋悙閸ユ挳姊洪崨濠冨闁告ê鍚嬫穱濠冪鐎ｎ偄鈧敻鎮峰▎蹇擃仾缂佲偓閳ь剟姊哄ú璇插箹闁稿﹤鐏濋锝嗙節濮橆剙宓嗛梺闈涚箳婵挳鎳撻崸妤佲拺闁告繂瀚婵嗏攽椤旀儳鍘撮柟顔诲嵆婵偓闁靛牆妫楅埀顒€鐏氱换娑㈠醇濠靛牅铏庨梺鍝勵儐閻熝呮閹烘鏁婇柣锝呮湰閸ｄ即姊洪棃娑欘棛缂佲偓娓氣偓閿濈偛顭ㄩ崼婵堝姦濡炪倖甯掔€氼剛绮婚弽銊х闁糕剝蓱鐏忎即鏌涢妶鍡楃仸闁靛洤瀚伴獮鎺楀箣濠靛啫浜鹃柟闂寸閸欏﹪鏌曟径娑橆洭缂佲檧鍋撻梻浣圭湽閸ㄨ棄顭囪閻楀孩淇婇悙顏勨偓鏍ь潖瑜版帗鍋嬮柣妯垮皺閺嗭箓鏌℃径搴殾闁哄啫鐗嗙粈鍐┿亜韫囨挻顥滄い锔规櫊濮婄粯鎷呮笟顖涚秺闂佸憡娲栭悘姘舵偩閸撲胶纾奸柣鎰靛墮閸斻倗绱撳鍜冭含鐎殿喖顭烽弫鎾绘偐閼碱剙鈧偤姊虹€圭姰鈧偓闁稿鎸剧槐鎺撴綇椤愶絿褰х紓浣虹帛缁嬫垿顢欒箛娑辨晩缂備焦锚閺嬨倝姊绘担鑺ャ€冪紒鈧担璇ユ椽顢橀姀鐘烘憰闂佸搫娴勭槐鏇㈡偪閳ь剟鏌ｆ惔顖滅У濞存粎鍋炵粋鎺楁嚃閳哄啰锛濇繛杈剧秮椤ユ挾绮佃箛鏇犵＜闁绘娅曞畷宀€鈧鍠栭…鐑藉箖閵忋倖鍋傞幖杈剧秵濡差垶姊绘担绋挎倯缂佷焦鎸冲鎻掝煥閸愶絾鐏佸銈嗗笒鐎氼參鍩涢幋锔界厱婵炴垶锕弨濠氭煟閹惧崬鍔ょ紒杈ㄥ笚瀵板嫭绻濋崟顓夈劌螖? missing target"}
        first = _message_dedupe_key(role="agent", original_type="task_error", stored_type="status", content=content)
        second = _message_dedupe_key(role="agent", original_type="task_error", stored_type="status", content=dict(content))
        self.assertEqual(first, second)
        self.assertTrue(first.startswith("task_error:"))

    def test_tool_output_dedupe_key_uses_tool_run_id(self):
        key = _message_dedupe_key(
            role="agent",
            original_type="tool_output",
            stored_type="tool_call",
            content={"tool_run_id": "run-1", "stdout": "a"},
        )
        self.assertEqual(key, "tool:run-1")

    def test_streaming_text_dedupe_key_uses_stream_id(self):
        key = _message_dedupe_key(
            role="agent",
            original_type="text",
            stored_type="text",
            content={"stream_id": "task-1:assistant:1", "text": "partial"},
        )
        self.assertEqual(key, "text:task-1:assistant:1")

    def test_streaming_text_merge_replaces_with_latest_accumulated_text(self):
        existing = {"stream_id": "s1", "text": "hello", "agent_source": "pentest"}
        incoming = {"stream_id": "s1", "text": "hello world", "agent_source": "pentest"}
        merged = _merge_saved_message_content(existing, incoming, "text")

        self.assertEqual(merged["text"], "hello world")
        self.assertEqual(merged["stream_id"], "s1")

    def test_tool_output_merge_appends_new_lines_without_duplicate_tail(self):
        existing = {"tool_run_id": "run-1", "stdout": "line one", "status": "running"}
        incoming = {"tool_run_id": "run-1", "stdout": "line two", "status": "done"}
        merged = _merge_saved_message_content(existing, incoming, "tool_call")
        self.assertEqual(merged["stdout"], "line one\nline two")
        self.assertEqual(merged["status"], "done")
        merged_again = _merge_saved_message_content(merged, incoming, "tool_call")
        self.assertEqual(merged_again["stdout"], "line one\nline two")

    def test_tool_output_merge_keeps_one_structured_item_per_run(self):
        existing = {
            "tool_name": "http_request",
            "tool_run_id": "run-1",
            "stdout": "http_request GET http://target.local/robots.txt...",
            "status": "running",
            "tool_items": [{
                "tool_name": "http_request",
                "tool_run_id": "run-1",
                "stdout": "http_request GET http://target.local/robots.txt...",
                "status": "running",
            }],
        }
        incoming = {
            "tool_name": "http_request",
            "tool_run_id": "run-1",
            "stdout": "EVIDENCE_ID: ev-1\n{'status': 'done', 'url': 'http://target.local/robots.txt', 'method': 'GET'}",
            "status": "done",
            "evidence_id": "ev-1",
        }
        merged = _merge_saved_message_content(existing, incoming, "tool_call")

        self.assertEqual(merged["evidence_id"], "ev-1")
        self.assertEqual(len(merged["tool_items"]), 1)
        self.assertEqual(merged["tool_items"][0]["evidence_id"], "ev-1")
        self.assertIn("http_request GET", merged["tool_items"][0]["stdout"])
        self.assertIn("EVIDENCE_ID: ev-1", merged["tool_items"][0]["stdout"])

    def test_agent_assignment_notice_names_selected_agent(self):
        decision = type("Decision", (), {"agent": "pentest", "capability": "pentest.web"})()

        notice = _agent_assignment_notice(decision, "12345678-1234-1234-1234-123456789abc", "web-node-1")

        self.assertIn("\u6e17\u900f Agent", notice)
        self.assertIn("web-node-1", notice)
        self.assertIn("pentest.web", notice)
    def test_candidate_vuln_messages_are_not_persisted_as_vulnerabilities(self):
        result = asyncio.run(_persist_vulnerability({
            "conversation_id": "00000000-0000-0000-0000-000000000001",
            "status": "candidate",
            "title": "Candidate only",
        }, None))
        self.assertIsNone(result)

    def test_confirmed_vuln_without_evidence_is_not_persisted(self):
        result = asyncio.run(_persist_vulnerability({
            "conversation_id": "00000000-0000-0000-0000-000000000001",
            "status": "confirmed",
            "title": "No evidence",
            "evidence_ids": [],
        }, None))
        self.assertIsNone(result)



    def test_task_assign_target_comes_from_platform_agent_decision(self):
        msg = {"type": "user_message", "text": "test whatever the user said"}
        decision = type("Decision", (), {"targets": ["http://agent-plan.local/"]})()

        updated = _message_with_decision_target(msg, decision)

        self.assertEqual(updated["target"], {"type": "url", "value": "http://agent-plan.local/"})
        self.assertEqual(updated["scope"], {"allow": ["http://agent-plan.local/"], "deny": []})

    def test_platform_agent_plan_dispatches_to_pentest_capability(self):
        async def fake_chat(messages):
            return '{"action":"start_task","capability":"pentest.web","agent":"pentest","targets":["http://target.local"],"reason":"user requested a web pentest"}'

        async def run():
            set_orchestrator_chat_override(fake_chat)
            try:
                return await route_with_platform_agent(
                    text="Please test http://target.local",
                    context=OrchestrationContext(
                        conversation_status="created",
                        capabilities=[AgentCapability(agent_type="pentest", capability="pentest.web", node_id="node-1", online=True)],
                    ),
                )
            finally:
                set_orchestrator_chat_override(None)

        decision = asyncio.run(run())
        self.assertEqual(decision.action, "dispatch_node")
        self.assertEqual(decision.capability, "pentest.web")
        self.assertEqual(decision.agent, "pentest")

    def test_platform_agent_plan_is_only_target_source_for_dispatch(self):
        text = "\u5bf9http://host.docker.internal:3000/\u8fdb\u884c Web \u5e94\u7528\u6e17\u900f\u6d4b\u8bd5"

        async def fake_chat(messages):
            return '{"action":"start_task","capability":"pentest.web","agent":"pentest","targets":[],"reason":"bad plan missing target"}'

        async def run():
            set_orchestrator_chat_override(fake_chat)
            try:
                return await route_with_platform_agent(
                    text=text,
                    context=OrchestrationContext(conversation_status="created"),
                )
            finally:
                set_orchestrator_chat_override(None)

        decision = asyncio.run(run())
        self.assertEqual(decision.action, "ask_clarification")
        self.assertEqual(decision.mode, "missing_target")

    def test_platform_agent_sanitizes_chinese_suffix_in_plan_target(self):
        async def fake_chat(messages):
            return '{"action":"start_task","capability":"pentest.web","agent":"pentest","targets":["http://host.docker.internal:3000/\u8fdb\u884c"],"reason":"single supplied target"}'

        async def run():
            set_orchestrator_chat_override(fake_chat)
            try:
                return await route_with_platform_agent(
                    text="\u5bf9http://host.docker.internal:3000/\u8fdb\u884c Web \u5e94\u7528\u6e17\u900f\u6d4b\u8bd5",
                    context=OrchestrationContext(conversation_status="created"),
                )
            finally:
                set_orchestrator_chat_override(None)

        decision = asyncio.run(run())
        self.assertEqual(decision.action, "dispatch_node")
        self.assertEqual(decision.targets, ["http://host.docker.internal:3000/"])

    def test_platform_agent_plan_single_chinese_target_dispatches(self):
        text = "\u5bf9http://host.docker.internal:3000/\u8fdb\u884c Web \u5e94\u7528\u6e17\u900f\u6d4b\u8bd5"

        async def fake_chat(messages):
            return '{"action":"start_task","capability":"pentest.web","agent":"pentest","targets":["http://host.docker.internal:3000/"],"reason":"single supplied target"}'

        async def run():
            set_orchestrator_chat_override(fake_chat)
            try:
                return await route_with_platform_agent(
                    text=text,
                    context=OrchestrationContext(conversation_status="created"),
                )
            finally:
                set_orchestrator_chat_override(None)

        decision = asyncio.run(run())
        self.assertEqual(decision.action, "dispatch_node")
        self.assertEqual(decision.capability, "pentest.web")

    def test_platform_agent_plan_multiple_targets_is_policy_clarification(self):
        async def fake_chat(messages):
            return '{"action":"start_task","capability":"pentest.web","agent":"pentest","targets":["http://one.local","http://two.local"],"reason":"two targets"}'

        async def run():
            set_orchestrator_chat_override(fake_chat)
            try:
                return await route_with_platform_agent(
                    text="Test http://one.local and http://two.local",
                    context=OrchestrationContext(conversation_status="created"),
                )
            finally:
                set_orchestrator_chat_override(None)

        decision = asyncio.run(run())
        self.assertEqual(decision.action, "ask_clarification")
        self.assertEqual(decision.mode, "multiple_targets")

    def test_platform_agent_can_answer_about_multiple_targets_without_dispatching(self):
        async def fake_chat(messages):
            return '{"action":"answer_user","capability":"platform.chat","agent":"platform","targets":["http://one.local","http://two.local"],"reason":"user asked for comparison, not execution"}'

        async def run():
            set_orchestrator_chat_override(fake_chat)
            try:
                return await route_with_platform_agent(
                    text="Which demo target is better, http://one.local or http://two.local?",
                    context=OrchestrationContext(conversation_status="created"),
                )
            finally:
                set_orchestrator_chat_override(None)

        decision = asyncio.run(run())
        self.assertEqual(decision.action, "platform_reply")
        self.assertEqual(decision.capability, "platform.chat")

    def test_requested_pentest_answer_uses_pentest_snapshot_context(self):
        async def fake_chat(messages):
            return '{"action":"answer_user","capability":"platform.chat","agent":"platform","targets":[],"reason":"greeting"}'

        async def run():
            set_orchestrator_chat_override(fake_chat)
            try:
                return await route_with_platform_agent(
                    text="hello",
                    context=OrchestrationContext(
                        conversation_status="completed",
                        requested_agent="pentest",
                        requested_node_id="node-1",
                        has_resume_task=True,
                        bound_node_id="node-1",
                    ),
                )
            finally:
                set_orchestrator_chat_override(None)

        decision = asyncio.run(run())
        self.assertEqual(decision.action, "platform_reply")
        self.assertEqual(decision.capability, "snapshot.qa")
        self.assertEqual(decision.mode, "snapshot_qa")
        self.assertEqual(decision.agent, "pentest")
        self.assertEqual(decision.agent_node_id, "node-1")

    def test_requested_pentest_clarification_uses_pentest_snapshot_when_session_exists(self):
        async def fake_chat(messages):
            return '{"action":"ask_clarification","capability":"platform.chat","agent":"platform","targets":[],"reason":"missing target"}'

        async def run():
            set_orchestrator_chat_override(fake_chat)
            try:
                return await route_with_platform_agent(
                    text="self evaluate the last test",
                    context=OrchestrationContext(
                        conversation_status="completed",
                        requested_agent="pentest",
                        requested_node_id="node-1",
                        has_resume_task=True,
                        bound_node_id="node-1",
                    ),
                )
            finally:
                set_orchestrator_chat_override(None)

        decision = asyncio.run(run())
        self.assertEqual(decision.action, "platform_reply")
        self.assertEqual(decision.capability, "snapshot.qa")
        self.assertEqual(decision.agent, "pentest")

    def test_platform_agent_invalid_plan_is_not_routed_by_fallback(self):
        async def fake_chat(messages):
            return 'not json'

        async def run():
            set_orchestrator_chat_override(fake_chat)
            try:
                return await route_with_platform_agent(
                    text="Please test http://target.local",
                    context=OrchestrationContext(conversation_status="created"),
                )
            finally:
                set_orchestrator_chat_override(None)

        with self.assertRaises(OrchestrationError):
            asyncio.run(run())

    def test_report_markdown_contains_deliverable_sections(self):
        markdown = _render_markdown({
            "conversation": {"id": "c1", "title": "Demo", "status": "completed"},
            "counts": {"assets": 1, "findings": 1, "evidence": 1},
            "agent_state": {"phase": "complete"},
            "progress": {"current": 6, "total": 6},
            "checkpoint": {"target": {"value": "http://target.local"}, "scope": {"allow": ["http://target.local"]}, "phase": "complete", "phases_completed": ["intake", "recon"]},
            "assets": [{"address": "http://target.local", "type": "web", "source": "agent_discovered", "properties": {"open_ports": [80]}}],
            "findings": [{"title": "Reflected XSS", "severity": "medium", "status": "confirmed", "confidence": "high", "location": "/search", "description": "Impact", "poc": "curl ...", "remediation": "Encode output", "evidence_ids": ["ev-1"]}],
            "evidence": [{"evidence_id": "ev-1", "type": "http", "source_tool": "http_request", "summary": "HTTP 200"}],
            "messages": [{"created_at": "2026-07-01T00:00:00Z", "role": "agent", "msg_type": "status", "content": {"text": "Phase: complete"}}],
        })
        for heading in ["## Summary", "## Assets", "## Vulnerabilities", "## Evidence", "## Timeline", "## Disclaimer"]:
            self.assertIn(heading, markdown)
        self.assertIn("http://target.local", markdown)
        self.assertIn("Reflected XSS", markdown)
        self.assertIn("ev-1", markdown)


if __name__ == "__main__":
    unittest.main()
